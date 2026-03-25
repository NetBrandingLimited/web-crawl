import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import * as cheerio from "cheerio";
import { sha1Hex } from "@/lib/crawl-url";

const MAX_URLS_PER_RUN = 10;

export async function GET(req: Request) {
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
    return NextResponse.json({ message: "No pending URLs" });
  }

  const results = [];

  for (const item of pending) {
    await prisma.crawlQueue.update({
      where: { id: item.id },
      data: { state: "in_progress" },
    });

    try {
      const response = await fetch(item.url, {
        headers: { "User-Agent": item.job.userAgent },
        signal: AbortSignal.timeout(15000),
      });

      const finalUrl = response.url;
      const status = response.status;
      const contentType = response.headers.get("content-type") ?? "";

      await prisma.url.upsert({
        where: {
          jobId_urlHash: {
            jobId: item.jobId,
            urlHash: item.urlHash,
          },
        },
        create: {
          jobId: item.jobId,
          urlHash: item.urlHash,
          url: item.url,
          finalUrl,
          statusCode: status,
          contentType,
          depth: item.depth,
          fetchedAt: new Date(),
        },
        update: {
          finalUrl,
          statusCode: status,
          contentType,
          fetchedAt: new Date(),
        },
      });

      if (contentType.includes("text/html") && item.depth < item.job.maxDepth) {
        const html = await response.text();
        const $ = cheerio.load(html);
        const seedUrl = new URL(item.job.seedUrl);

        $("a[href]").each((_, el) => {
          (async () => {
            try {
              const href = $(el).attr("href")!;
              const abs = new URL(href, item.url);
              if (item.job.sameSiteOnly && abs.hostname !== seedUrl.hostname) return;
              if (!["http:", "https:"].includes(abs.protocol)) return;
              abs.hash = "";
              const newUrl = abs.toString();
              const hash = sha1Hex(newUrl);
              const exists = await prisma.crawlQueue.findFirst({
                where: { jobId: item.jobId, urlHash: hash },
              });
              if (!exists) {
                await prisma.crawlQueue.create({
                  data: {
                    jobId: item.jobId,
                    urlHash: hash,
                    url: newUrl,
                    depth: item.depth + 1,
                    state: "pending",
                    priority: 0,
                    availableAt: new Date(),
                  },
                });
              }
            } catch {}
          })();
        });
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
      results.push({ url: item.url, ok: false, error: String(err) });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}  