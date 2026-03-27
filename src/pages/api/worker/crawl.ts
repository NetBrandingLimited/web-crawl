import type { NextApiRequest, NextApiResponse } from "next";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
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
const ROBOTS_TXT_FETCH_MS = Math.min(
  30_000,
  Math.max(2_000, parsePositiveInt(process.env.CRAWL_ROBOTS_TIMEOUT_MS, 5_000)),
);

type RobotsParsed = ReturnType<typeof robotsParser>;

async function getCachedRobots(
  robotsTxtUrl: string,
  userAgent: string,
  cache: Map<string, RobotsParsed>,
): Promise<RobotsParsed> {
  const hit = cache.get(robotsTxtUrl);
  if (hit) return hit;
  const empty = robotsParser(robotsTxtUrl, "");
  let parsed = empty;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROBOTS_TXT_FETCH_MS);
  try {
    const res = await fetch(robotsTxtUrl, {
      headers: { "user-agent": userAgent, accept: "text/plain,*/*;q=0.8" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const txt = await res.text();
    parsed = robotsParser(robotsTxtUrl, txt);
  } catch {
    parsed = empty;
  } finally {
    clearTimeout(timer);
  }
  cache.set(robotsTxtUrl, parsed);
  return parsed;
}

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

function capLen(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function extractSecurityResponseHeaders(headers: Headers) {
  const perm = headers.get("permissions-policy") ?? headers.get("feature-policy");
  return {
    hstsHeader: cleanHeaderValue(headers.get("strict-transport-security"), 512),
    cspHeader: capLen(cleanText(headers.get("content-security-policy")), 8192),
    xContentTypeOptionsHeader: cleanHeaderValue(headers.get("x-content-type-options"), 64),
    xFrameOptionsHeader: cleanHeaderValue(headers.get("x-frame-options"), 64),
    referrerPolicyHeader: cleanHeaderValue(headers.get("referrer-policy"), 128),
    permissionsPolicyHeader: capLen(cleanText(perm), 1024),
  };
}

/** Normalize HTTP header (e.g. X-Robots-Tag) for storage; cap length for VARCHAR. */
function cleanHeaderValue(v: string | null, maxLen: number): string | null {
  const t = cleanText(v);
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/** Resolve meta URL/content relative to page URL; cap length for VARCHAR columns. */
function absolutizeMetaUrl(raw: string | undefined | null, pageUrl: string, maxLen: number): string | null {
  const t = cleanText(raw);
  if (!t) return null;
  try {
    const abs = new URL(t, pageUrl).toString();
    return abs.length > maxLen ? abs.slice(0, maxLen) : abs;
  } catch {
    return t.length > maxLen ? t.slice(0, maxLen) : t;
  }
}

function collectJsonLdTypes(node: unknown, types: Set<string>): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectJsonLdTypes(x, types);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  if (typeof t === "string") types.add(t);
  else if (Array.isArray(t)) {
    for (const x of t) {
      if (typeof x === "string") types.add(x);
    }
  }
  for (const key of Object.keys(o)) {
    if (key === "@context") continue;
    collectJsonLdTypes(o[key], types);
  }
}

type RedirectHop = { url: string; status: number };

async function fetchWithRedirects(
  url: string,
  userAgent: string,
  maxHops = 10,
  timeoutMs = 30_000,
): Promise<{
  finalUrl: string;
  status: number;
  headers: Headers;
  body: Buffer | null;
  hops: RedirectHop[];
}> {
  const hops: RedirectHop[] = [];
  let current = url;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxHops; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        signal: ctrl.signal,
      });

      const status = res.status;
      const headers = res.headers;

      if (status >= 300 && status < 400) {
        const loc = headers.get("location");
        hops.push({ url: current, status });

        if (!loc) return { finalUrl: current, status, headers, body: null, hops };

        current = new URL(loc, current).toString();
        continue;
      }

      const ab = await res.arrayBuffer().catch(() => null);
      const body = ab ? Buffer.from(ab) : null;
      return { finalUrl: current, status, headers, body, hops };
    }

    // Exceeded max hops; return last URL without a valid body.
    return { finalUrl: current, status: 310, headers: new Headers(), body: null, hops };
  } finally {
    clearTimeout(timer);
  }
}

function isMissingAuditTableError(err: unknown): boolean {
  const msg = String(err);
  // If Phase 1 audit storage isn't ready (migration not applied yet, schema mismatch, etc),
  // we don't want the whole crawl worker to fail.
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
    const msg = String(err);
    if (msg.includes("CrawlPageAudit") || msg.includes("crawlPageAudit")) return null;
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
  const robotsTxtCache = new Map<string, RobotsParsed>();

  for (const item of pending) {
    // Mark as in_progress
    await prisma.crawlQueue.update({
      where: { id: item.id },
      data: { state: "in_progress" },
    });

    try {
      const requestedNormalized = normalizeUrl(item.url, item.job.stripTracking)?.toString() ?? item.url;

      if (item.job.obeyRobots) {
        let originForRobots: string | null = null;
        const nu = normalizeUrl(item.url, item.job.stripTracking);
        if (nu) {
          originForRobots = `${nu.protocol}//${nu.host}`;
        } else {
          try {
            const u = new URL(requestedNormalized);
            if (u.protocol === "http:" || u.protocol === "https:") {
              originForRobots = `${u.protocol}//${u.host}`;
            }
          } catch {
            originForRobots = null;
          }
        }
        if (originForRobots) {
          const robotsTxtUrl = `${originForRobots}/robots.txt`;
          const robots = await getCachedRobots(robotsTxtUrl, item.job.userAgent, robotsTxtCache);
          const allowed = robots.isAllowed(requestedNormalized, item.job.userAgent) ?? true;
          if (!allowed) {
            await safeAuditWrite(() =>
              prisma.crawlPageAudit.upsert({
                where: { jobId_urlHash: { jobId: item.jobId, urlHash: item.urlHash } },
                create: {
                  jobId: item.jobId,
                  urlHash: item.urlHash,
                  url: requestedNormalized,
                  depth: item.depth,
                  fetchError: "robots_disallowed",
                  fetchedAt: new Date(),
                },
                update: {
                  url: requestedNormalized,
                  depth: item.depth,
                  fetchError: "robots_disallowed",
                  httpStatus: null,
                  fetchedAt: new Date(),
                },
              }),
            );
            await prisma.crawlQueue.update({
              where: { id: item.id },
              data: { state: "skipped", lastError: "robots_disallowed" },
            });
            results.push({ url: item.url, status: 0, ok: true, error: "robots_disallowed" });
            continue;
          }
        }
      }

      const fetchStartedAt = new Date();
      const result = await fetchWithRedirects(
        requestedNormalized,
        item.job.userAgent,
        item.job.followRedirects ? 10 : 0,
        FETCH_TIMEOUT_MS,
      );
      const responseTimeMs = Math.min(2_147_483_647, Date.now() - fetchStartedAt.getTime());

      const finalUrl = result.finalUrl;
      const status = result.status;
      const contentType = result.headers.get("content-type") ?? "";
      const xRobotsTag = cleanHeaderValue(result.headers.get("x-robots-tag"), 512);
      const securityHeaders = extractSecurityResponseHeaders(result.headers);
      const contentLengthHeader = result.headers.get("content-length");
      const contentLength = contentLengthHeader
        ? BigInt(contentLengthHeader)
        : result.body
          ? BigInt(result.body.length)
          : null;

      // Normalize the final URL (post-redirect) to keep `Url.urlHash` consistent.
      const finalNormalized = normalizeUrl(finalUrl, item.job.stripTracking)?.toString() ?? finalUrl;
      const urlHash = sha1Hex(finalNormalized);

      const urlRow = await prisma.url.upsert({
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
        select: { id: true },
      });

      // Persist redirect chain + fetch metadata for reports.
      const fetchRow = await prisma.urlFetch.create({
        data: {
          jobId: item.jobId,
          urlId: urlRow.id,
          requestedUrl: requestedNormalized,
          requestedAt: fetchStartedAt,
          finishedAt: new Date(),
          status: "success",
          httpStatus: status || null,
          contentType,
          contentLength,
          redirectChain: result.hops.length ? JSON.stringify(result.hops) : null,
          redirectHops: result.hops.length || null,
        },
        select: { id: true },
      });

      if (result.hops.length) {
        await prisma.redirect.createMany({
          data: result.hops.map((h, idx) => ({
            fetchId: fetchRow.id,
            hopOrder: idx,
            fromUrl: h.url,
            toUrl: idx < result.hops.length - 1 ? result.hops[idx + 1].url : finalNormalized,
            statusCode: h.status,
          })),
        });
      }

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
            responseTimeMs,
            ...securityHeaders,
          },
          update: {
            url: finalNormalized,
            depth: item.depth,
            httpStatus: status,
            contentType,
            fetchError: null,
            responseTimeMs,
            ...securityHeaders,
            fetchedAt: new Date(),
          },
        }),
      );

      // Parse HTML for audit on every HTML response; enqueue links only under max depth.
      if (contentType.includes("text/html")) {
        const html = result.body ? result.body.toString("utf8") : "";
        const $ = cheerio.load(html);

        if (item.depth < item.job.maxDepth) {
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
        }

        const title = cleanText($("head > title").first().text());
        const metaDesc = cleanText($("meta[name='description']").attr("content"));
        const ogTitle = capLen(cleanText($('meta[property="og:title"]').attr("content")), 512);
        const ogDescription = capLen(cleanText($('meta[property="og:description"]').attr("content")), 16_384);
        const ogImage = absolutizeMetaUrl($('meta[property="og:image"]').attr("content"), item.url, 2048);
        const twitterCard = capLen(cleanText($('meta[name="twitter:card"]').attr("content")), 64);
        const twitterTitle = capLen(cleanText($('meta[name="twitter:title"]').attr("content")), 512);
        const canonicalUrl = cleanText($("link[rel='canonical']").attr("href"));
        const robotsMeta = cleanText($("meta[name='robots']").attr("content"));
        const h1Count = $("h1").length;
        const h2Count = $("h2").length;
        const hreflangCount = $("link[rel='alternate'][hreflang]").length;
        const linksOutCount = $("a[href]").length;
        const seedHost = new URL(item.job.seedUrl).hostname.toLowerCase();
        let linksExternalCount = 0;
        $("a[href]").each((_, el) => {
          try {
            const href = $(el).attr("href");
            if (href == null || href === "") return;
            const abs = new URL(href, item.url);
            if (abs.protocol !== "http:" && abs.protocol !== "https:") return;
            if (abs.hostname.toLowerCase() !== seedHost) linksExternalCount += 1;
          } catch {
            /* ignore malformed href */
          }
        });
        const imgCount = $("img").length;
        let imgMissingAltCount = 0;
        $("img").each((_, el) => {
          if ($(el).attr("alt") === undefined) imgMissingAltCount += 1;
        });
        const bodyText = cleanText($("body").text()) ?? "";
        const wordCount = bodyText.length === 0 ? 0 : bodyText.split(" ").length;
        const contentHash = bodyText.length > 0 ? sha1Hex(bodyText.toLowerCase()) : null;

        let jsonLdCount = 0;
        const jsonLdTypes = new Set<string>();
        $('script[type="application/ld+json"]').each((_, el) => {
          const raw = $(el).html()?.trim() ?? "";
          if (!raw) return;
          jsonLdCount += 1;
          try {
            collectJsonLdTypes(JSON.parse(raw), jsonLdTypes);
          } catch {
            /* invalid JSON-LD */
          }
        });
        const jsonLdTypesSorted = [...jsonLdTypes].sort();
        const jsonLdTypesSummary =
          jsonLdTypesSorted.length === 0
            ? null
            : jsonLdTypesSorted.slice(0, 40).join("|").slice(0, 1024);

        await safeAuditWrite(() =>
          prisma.crawlPageAudit.update({
            where: { jobId_urlHash: { jobId: item.jobId, urlHash } },
            data: {
              title,
              titleLength: title?.length ?? null,
              metaDesc,
              metaDescLength: metaDesc?.length ?? null,
              ogTitle,
              ogDescription,
              ogImage,
              twitterCard,
              twitterTitle,
              h1Count,
              h2Count,
              canonicalUrl,
              robotsMeta,
              xRobotsTag,
              hreflangCount,
              linksOutCount,
              linksExternalCount,
              imgCount,
              imgMissingAltCount,
              jsonLdCount,
              jsonLdTypesSummary,
              wordCount,
              contentHash,
              fetchedAt: new Date(),
            },
          }),
        );
      } else {
        await safeAuditWrite(() =>
          prisma.crawlPageAudit.update({
            where: { jobId_urlHash: { jobId: item.jobId, urlHash } },
            data: {
              xRobotsTag,
              jsonLdCount: 0,
              jsonLdTypesSummary: null,
              linksExternalCount: 0,
              ogTitle: null,
              ogDescription: null,
              ogImage: null,
              twitterCard: null,
              twitterTitle: null,
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

