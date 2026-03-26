import type { NextApiRequest, NextApiResponse } from "next"; 
import * as cheerio from "cheerio";
import { prisma } from "@/lib/prisma";
import { normalizeInputToUrl, sha1Hex } from "@/lib/crawl-url";

/** Vercel Hobby ~10s; keep defaults small. Override on Pro+ via env + vercel.json maxDuration. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const URLS_PER_RUN = parsePositiveInt(process.env.CRAWL_URLS_PER_RUN, 1);
const FETCH_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(1_000, parsePositiveInt(process.env.CRAWL_FETCH_TIMEOUT_MS, 8_000)),
);
const MAX_DISCOVERED_LINKS = parsePositiveInt(process.env.CRAWL_MAX_DISCOVERED_LINKS, 400);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseJobIdFilter(raw: string | string[] | undefined): string | undefined {
  const s = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!s || !UUID_RE.test(s)) return undefined;
  return s;
}

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

function cleanText(v: string | undefined | null): string | null {
  if (!v) return null;
  const normalized = v.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function isMissingAuditTableError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("CrawlPageAudit") &&
    (msg.includes("does not exist") ||
      msg.includes("relation") ||
      msg.includes("table") ||
      msg.includes("column") ||
      msg.includes("unknown column") ||
      msg.includes("UndefinedColumn"))
  );
}

async function safeAuditWrite<T>(op: () => Promise<T>): Promise<T | null> {
  try {
    return await op();
  } catch (err) {
    if (isMissingAuditTableError(err)) return null;
    throw err;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ message: "Method not allowed" });
    }

  const jobIdFilter = parseJobIdFilter(req.query.jobId);

  const pending = await prisma.crawlQueue.findMany({
    where: {
      state: "pending",
      availableAt: { lte: new Date() },
      ...(jobIdFilter ? { jobId: jobIdFilter } : {}),
    },
    orderBy: { priority: "desc" },
    take: URLS_PER_RUN,
    include: { job: true },
  });

  if (pending.length === 0) {
    return res.status(200).json({ message: "No pending URLs", jobId: jobIdFilter ?? null });
  }

  const touchedJobIds = new Set<string>();
  for (const jid of pending.map((p) => p.jobId)) {
    touchedJobIds.add(jid);
    await prisma.crawlJob.updateMany({
      where: { id: jid, startedAt: null },
      data: { status: "running", startedAt: new Date() },
    });
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

      await safeAuditWrite(() =>
        prisma.crawlPageAudit.upsert({
          where: { jobId_urlHash: { jobId: item.jobId, urlHash } },
          create: {
            jobId: item.jobId,
            urlHash,
            url: finalNormalized,
            depth: item.depth,
            httpStatus: status,
            contentType,
          },
          update: {
            url: finalNormalized,
            depth: item.depth,
            httpStatus: status,
            contentType,
            fetchError: null,
            fetchedAt: new Date(),
          },
        }),
      );

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

        const seenHashes = new Set<string>();
        const toEnqueue: { url: string; urlHash: string }[] = [];
        for (const u of discovered) {
          const h = sha1Hex(u);
          if (seenHashes.has(h)) continue;
          seenHashes.add(h);
          toEnqueue.push({ url: u, urlHash: h });
          if (toEnqueue.length >= MAX_DISCOVERED_LINKS) break;
        }

        const now = new Date();
        const queuedSoFar = await prisma.crawlQueue.count({ where: { jobId: item.jobId } });
        const room = item.job.maxPages - queuedSoFar;
        const allowedNew = Math.max(0, Math.min(room, toEnqueue.length));
        const slice = allowedNew > 0 ? toEnqueue.slice(0, allowedNew) : [];

        if (slice.length > 0) {
          await prisma.crawlQueue.createMany({
            data: slice.map((row) => ({
              jobId: item.jobId,
              urlHash: row.urlHash,
              url: row.url,
              depth: item.depth + 1,
              state: "pending",
              priority: 0,
              availableAt: now,
            })),
            skipDuplicates: true,
          });
        }

        const title = cleanText($("head > title").first().text());
        const metaDesc = cleanText($("meta[name='description']").attr("content"));
        const canonicalUrl = cleanText($("link[rel='canonical']").attr("href"));
        const robotsMeta = cleanText($("meta[name='robots']").attr("content"));
        const h1Count = $("h1").length;
        const h2Count = $("h2").length;
        const hreflangCount = $("link[rel='alternate'][hreflang]").length;
        const linksOutCount = $("a[href]").length;
        const bodyText = cleanText($("body").text()) ?? "";
        const wordCount = bodyText.length === 0 ? 0 : bodyText.split(" ").length;
        const contentHash = bodyText.length > 0 ? sha1Hex(bodyText.toLowerCase()) : null;

        await safeAuditWrite(() =>
          prisma.crawlPageAudit.update({
            where: { jobId_urlHash: { jobId: item.jobId, urlHash } },
            data: {
              title,
              titleLength: title?.length ?? null,
              metaDesc,
              metaDescLength: metaDesc?.length ?? null,
              h1Count,
              h2Count,
              canonicalUrl,
              robotsMeta,
              hreflangCount,
              linksOutCount,
              wordCount,
              contentHash,
              fetchedAt: new Date(),
            },
          }),
        );
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
      await safeAuditWrite(() =>
        prisma.crawlPageAudit.upsert({
          where: { jobId_urlHash: { jobId: item.jobId, urlHash: item.urlHash } },
          create: {
            jobId: item.jobId,
            urlHash: item.urlHash,
            url: item.url,
            depth: item.depth,
            fetchError: String(err).slice(0, 500),
            fetchedAt: new Date(),
          },
          update: {
            url: item.url,
            depth: item.depth,
            fetchError: String(err).slice(0, 500),
            fetchedAt: new Date(),
          },
        }),
      );
      results.push({ url: item.url, ok: false, status: 0, error: String(err) });
    }
  }

  const nowCheck = new Date();
  for (const jid of touchedJobIds) {
    const pendingLeft = await prisma.crawlQueue.count({
      where: { jobId: jid, state: "pending", availableAt: { lte: nowCheck } },
    });
    const inProgressLeft = await prisma.crawlQueue.count({
      where: { jobId: jid, state: "in_progress" },
    });
    if (pendingLeft === 0 && inProgressLeft === 0) {
      await prisma.crawlJob.updateMany({
        where: { id: jid, status: { not: "canceled" } },
        data: { status: "completed", finishedAt: new Date() },
      });
    }
  }

    return res.status(200).json({
      processed: results.length,
      results,
      jobId: jobIdFilter ?? null,
    });
  } catch (err) {
    console.error("crawl-worker fatal error:", err);
    return res.status(500).json({
      message: `Crawler failed: ${String(err)}`,
      error: String(err),
    });
  }
}

