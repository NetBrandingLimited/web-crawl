import "dotenv/config";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { prisma } from "@/lib/prisma";
import { normalizeInputToUrl, sha1Hex } from "@/lib/crawl-url";

type RedirectHop = { url: string; status: number };

function now() {
  return new Date();
}

function isHtml(contentType: string | null) {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("text/html") || contentType.toLowerCase().includes("application/xhtml+xml");
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

function normalizeUrl(raw: string, base?: string, stripTracking = true): URL | null {
  try {
    const u = base ? new URL(raw, base) : normalizeInputToUrl(raw);
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

async function fetchWithRedirects(
  url: string,
  userAgent: string,
  maxHops = 10,
): Promise<{
  finalUrl: string;
  status: number;
  headers: Headers;
  body: Buffer | null;
  hops: RedirectHop[];
}> {
  const hops: RedirectHop[] = [];
  let current = url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const status = res.status;
    const headers = res.headers;

    if (status >= 300 && status < 400) {
      const loc = headers.get("location");
      hops.push({ url: current, status });
      if (!loc) {
        return { finalUrl: current, status, headers, body: null, hops };
      }
      const next = new URL(loc, current).toString();
      current = next;
      continue;
    }

    const ab = await res.arrayBuffer().catch(() => null);
    const body = ab ? Buffer.from(ab) : null;
    return { finalUrl: current, status, headers, body, hops };
  }

  return { finalUrl: current, status: 310, headers: new Headers(), body: null, hops };
}

async function getRobots(domainSeedUrl: string, userAgent: string) {
  const u = new URL(domainSeedUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  const parsed = robotsParser(robotsUrl, "");

  try {
    const res = await fetch(robotsUrl, { headers: { "user-agent": userAgent }, redirect: "follow" });
    const txt = await res.text();
    return robotsParser(robotsUrl, txt);
  } catch {
    return parsed;
  }
}

function withinScope(target: URL, seed: URL, sameSiteOnly: boolean, includeSubdomains: boolean) {
  if (!sameSiteOnly) return true;
  if (target.hostname === seed.hostname) return true;
  if (includeSubdomains) {
    return target.hostname.endsWith(`.${seed.hostname}`);
  }
  return false;
}

async function processOneQueueItem(jobId: string) {
  const job = await prisma.crawlJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      seedUrl: true,
      status: true,
      maxDepth: true,
      maxPages: true,
      maxDurationSeconds: true,
      includeSubdomains: true,
      sameSiteOnly: true,
      stripTracking: true,
      obeyRobots: true,
      followRedirects: true,
      userAgent: true,
      createdAt: true,
      startedAt: true,
    },
  });
  if (!job) return { didWork: false };

  if (job.status === "queued") {
    await prisma.crawlJob.update({
      where: { id: jobId },
      data: { status: "running", startedAt: job.startedAt ?? now() },
    });
  }

  if (job.status !== "queued" && job.status !== "running") return { didWork: false };

  const startedAt = job.startedAt ?? job.createdAt;
  const elapsedSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  if (elapsedSeconds > job.maxDurationSeconds) {
    await prisma.crawlJob.update({ where: { id: jobId }, data: { status: "completed", finishedAt: now() } });
    return { didWork: false };
  }

  const fetchedCount = await prisma.crawlQueue.count({
    where: { jobId, state: { in: ["done", "skipped"] } },
  });
  if (fetchedCount >= job.maxPages) {
    await prisma.crawlJob.update({ where: { id: jobId }, data: { status: "completed", finishedAt: now() } });
    return { didWork: false };
  }

  const next = await prisma.crawlQueue.findFirst({
    where: {
      jobId,
      state: "pending",
      OR: [{ availableAt: null }, { availableAt: { lte: now() } }],
    },
    orderBy: [{ priority: "desc" }, { availableAt: "asc" }, { enqueueAt: "asc" }],
  });

  if (!next) {
    await prisma.crawlJob.update({ where: { id: jobId }, data: { status: "completed", finishedAt: now() } });
    return { didWork: false };
  }

  // claim
  const claimed = await prisma.crawlQueue.update({
    where: { id: next.id },
    data: { state: "in_progress" },
    select: { id: true, url: true, depth: true, urlHash: true },
  });

  const seed = new URL(job.seedUrl);
  const normalized = normalizeUrl(claimed.url, undefined, job.stripTracking) ?? new URL(job.seedUrl);

  if (claimed.depth > job.maxDepth) {
    await prisma.crawlQueue.update({ where: { id: claimed.id }, data: { state: "skipped", lastError: "max_depth" } });
    return { didWork: true };
  }

  if (!withinScope(normalized, seed, job.sameSiteOnly, job.includeSubdomains)) {
    await prisma.crawlQueue.update({ where: { id: claimed.id }, data: { state: "skipped", lastError: "out_of_scope" } });
    return { didWork: true };
  }

  let robotsAllowed = true;
  if (job.obeyRobots) {
    const robots = await getRobots(job.seedUrl, job.userAgent);
    robotsAllowed = robots.isAllowed(normalized.toString(), job.userAgent) ?? true;
  }
  if (!robotsAllowed) {
    await prisma.crawlQueue.update({ where: { id: claimed.id }, data: { state: "skipped", lastError: "robots_disallowed" } });
    return { didWork: true };
  }

  const fetchStartedAt = now();
  let finalUrl = normalized.toString();
  let status = 0;
  let contentType: string | null = null;
  let contentLength: number | null = null;
  let canonicalFromHtml: string | null = null;
  let canonicalFromHeader: string | null = null;
  let redirectChain: RedirectHop[] = [];
  let errorMessage: string | null = null;
  let body: Buffer | null = null;

  try {
    const result = await fetchWithRedirects(normalized.toString(), job.userAgent, job.followRedirects ? 10 : 0);
    finalUrl = result.finalUrl;
    status = result.status;
    contentType = result.headers.get("content-type");
    const cl = result.headers.get("content-length");
    contentLength = cl ? Number(cl) : result.body ? result.body.length : null;
    body = result.body;
    redirectChain = result.hops;

    const linkHeader = result.headers.get("link");
    if (linkHeader && linkHeader.includes('rel="canonical"')) {
      canonicalFromHeader = linkHeader;
    }

    if (body && body.length > 0 && isHtml(contentType)) {
      // cap parsing at ~2MB
      const capped = body.length > 2_000_000 ? body.subarray(0, 2_000_000) : body;
      const $ = cheerio.load(capped.toString("utf8"));
      const canon = $('link[rel="canonical"]').attr("href");
      if (canon) {
        const c = normalizeUrl(canon, finalUrl, job.stripTracking);
        canonicalFromHtml = c?.toString() ?? null;
      }

      const links: string[] = [];
      $("a[href], area[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (href) links.push(href);
      });

      const nextDepth = claimed.depth + 1;
      if (nextDepth <= job.maxDepth) {
        for (const href of links) {
          const u = normalizeUrl(href, finalUrl, job.stripTracking);
          if (!u) continue;
          if (!withinScope(u, seed, job.sameSiteOnly, job.includeSubdomains)) continue;
          const urlStr = u.toString();
          const hash = sha1Hex(urlStr);

          await prisma.crawlQueue
            .create({
              data: {
                jobId,
                urlHash: hash,
                url: urlStr,
                depth: nextDepth,
                discoveredFromUrlHash: claimed.urlHash,
                state: "pending",
                priority: 0,
                availableAt: now(),
              },
            })
            .catch(() => null);

          await prisma.url
            .upsert({
              where: { urlHash: hash },
              create: {
                domainId: (await prisma.crawlJob.findUnique({ where: { id: jobId }, select: { domainId: true } }))!
                  .domainId,
                urlHash: hash,
                url: urlStr,
                robotsAllowed: true,
              },
              update: { lastSeenAt: now() },
            })
            .catch(() => null);
        }
      }
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : "fetch_failed";
  }

  const fetchFinishedAt = now();

  // Upsert Url + create UrlFetch
  const finalNormalized = normalizeUrl(finalUrl, undefined, job.stripTracking)?.toString() ?? finalUrl;
  const urlHash = sha1Hex(finalNormalized);

  const urlRow = await prisma.url.upsert({
    where: { urlHash },
    create: {
      domainId: (await prisma.crawlJob.findUnique({ where: { id: jobId }, select: { domainId: true } }))!.domainId,
      urlHash,
      url: finalNormalized,
      httpStatus: status || null,
      contentType,
      contentLength: contentLength ? BigInt(contentLength) : null,
      lastCrawlAt: fetchFinishedAt,
      robotsAllowed: robotsAllowed,
    },
    update: {
      httpStatus: status || null,
      contentType,
      contentLength: contentLength ? BigInt(contentLength) : null,
      lastCrawlAt: fetchFinishedAt,
      robotsAllowed: robotsAllowed,
      lastSeenAt: fetchFinishedAt,
    },
    select: { id: true },
  });

  const fetchRow = await prisma.urlFetch.create({
    data: {
      jobId,
      urlId: urlRow.id,
      requestedUrl: normalized.toString(),
      requestedAt: fetchStartedAt,
      finishedAt: fetchFinishedAt,
      status: errorMessage ? "error" : "success",
      httpStatus: status || null,
      contentType,
      contentLength: contentLength ? BigInt(contentLength) : null,
      redirectChain: redirectChain.length ? JSON.stringify(redirectChain) : null,
      redirectHops: redirectChain.length || null,
      canonicalFromHtml,
      canonicalFromHeader,
      errorMessage,
    },
    select: { id: true },
  });

  if (redirectChain.length) {
    await prisma.redirect.createMany({
      data: redirectChain.map((h, idx) => ({
        fetchId: fetchRow.id,
        hopOrder: idx,
        fromUrl: h.url,
        toUrl: idx < redirectChain.length - 1 ? redirectChain[idx + 1].url : finalUrl,
        statusCode: h.status,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.crawlQueue.update({
    where: { id: claimed.id },
    data: { state: errorMessage ? "skipped" : "done", lastError: errorMessage },
  });

  return { didWork: true };
}

async function tick() {
  const job = await prisma.crawlJob.findFirst({
    where: { status: { in: ["queued", "running"] } },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true },
  });

  if (!job) return false;

  const res = await processOneQueueItem(job.id);
  return res.didWork;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log("crawler worker starting");
  // eslint-disable-next-line no-console
  console.log("DATABASE_URL set:", Boolean(process.env.DATABASE_URL));

  while (true) {
    const didWork = await tick();
    if (!didWork) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

