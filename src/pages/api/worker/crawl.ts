import type { NextApiRequest, NextApiResponse } from "next"; 
import * as cheerio from "cheerio";
import { prisma } from "@/lib/prisma";
import { normalizeInputToUrl, sha1Hex } from "@/lib/crawl-url";

const MAX_URLS_PER_RUN = 10;

function stripTrackingParams(url: URL) {
  const toDelete: string[] = [];
  for (const [k] of url.searchParams) {
    const key = k.toLowerCase();
    if (key.startsWith("utm_")) toDelete.push(k);
    if (key === "fbclid" || key === "gclid" || key === "ref") toDelete.push(k);
  }
  toDelete.forEach((k) => url.searchParams.delete(k));
}

function normalizeUrl(raw: string, stripTracking = true): URL | null {
  try {
    const u = normalizeInputToUrl(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;

    u.hash = "";
    u.username = "";
    u.password = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();

    if (stripTracking) stripTrackingParams(u);
    return u;
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed" });
  }

  const pending = await prisma.crawlQueue.findMany({
    where: {
      state: "pending",
      availableAt: { lte: new Date() },
    },
    orderBy: { priority: "desc" },
    take: MAX_URLS_PER_RUN,
    include: { job: true },
  });

  if (pending.length === 0) {
    return res.status(200).json({ message: "No pending URLs" });
  }

  const results: { url: string; status: number; ok: boolean; error?: string }[] = [];

  for (const item of pending) {
    // Mark as in_progress
    await prisma.crawlQueue.update({
      where: { id: item.id },
      data: { state: "in_progress" },
    });

    try {
      const response = await fetch(item.url, {
        headers: { "User-Agent": item.job.userAgent },
        redirect: item.job.followRedirects ? "follow" : "manual",
        signal: AbortSignal.timeout(15000),
      });

      const finalUrl = response.url;
      const status = response.status;
      const contentType = response.headers.get("content-type") ?? "";
      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader ? BigInt(contentLengthHeader) : null;

      // Normalize the final URL (post-redirect) to keep `Url.urlHash` consistent.
      const finalNormalized = normalizeUrl(finalUrl, item.job.stripTracking)?.toString() ?? finalUrl;
      const urlHash = sha1Hex(finalNormalized);

      await prisma.url.upsert({
        where: { urlHash },
        create: {
          domainId: item.job.domainId,
          urlHash,
          url: finalNormalized,
          httpStatus: status,
          contentType,
          contentLength,
          lastCrawlAt: new Date(),
          robotsAllowed: true,
        },
        update: {
          contentType,
          httpStatus: status,
          contentLength,
          lastCrawlAt: new Date(),
          lastSeenAt: new Date(),
          robotsAllowed: true,
        },
      });

      // Parse HTML and discover new URLs
      if (contentType.includes("text/html") && item.depth < item.job.maxDepth) {
        const html = await response.text();
        const $ = cheerio.load(html);
        const seedUrl = new URL(item.job.seedUrl);
        const discovered: string[] = [];

        $("a[href]").each((_, el) => {
          try {
            const href = $(el).attr("href")!;
            const abs = new URL(href, item.url);
            if (item.job.sameSiteOnly && abs.hostname !== seedUrl.hostname) return;
            if (!["http:", "https:"].includes(abs.protocol)) return;
            abs.hash = "";
            discovered.push(abs.toString());
          } catch {
            // ignore malformed URLs
          }
        });

        for (const newUrl of discovered) {
          const hash = sha1Hex(newUrl);
          // Race-safe: another tick or concurrent worker may insert the same (jobId, urlHash).
          await prisma.crawlQueue
            .create({
              data: {
                jobId: item.jobId,
                urlHash: hash,
                url: newUrl,
                depth: item.depth + 1,
                state: "pending",
                priority: 0,
                availableAt: new Date(),
              },
            })
            .catch(() => null);
        }
      }

      await prisma.crawlQueue.update({
        where: { id: item.id },
        data: { state: "done" },
      });

      results.push({ url: item.url, status, ok: true });
    } catch (err) {
      await prisma.crawlQueue.update({
        where: { id: item.id },
        data: { state: "failed" },
      });
      results.push({ url: item.url, ok: false, status: 0, error: String(err) });
    }
  }

  return res.status(200).json({ processed: results.length, results });
}

