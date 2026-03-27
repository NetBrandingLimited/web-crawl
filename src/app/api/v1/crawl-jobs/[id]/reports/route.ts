import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteCtx = { params: Promise<{ id: string }> };

function hasNon2xx(httpStatus: number | null) {
  return httpStatus != null && (httpStatus < 200 || httpStatus >= 300);
}

function classifyIssues(row: {
  httpStatus: number | null;
  title: string | null;
  metaDesc: string | null;
  h1Count: number;
  canonicalUrl: string | null;
  fetchError: string | null;
  imgMissingAltCount: number;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  responseTimeMs: number | null;
}) {
  const issues: string[] = [];
  if (row.fetchError) {
    if (row.fetchError === "robots_disallowed") issues.push("robots_txt_disallowed");
    else issues.push("fetch_error");
  }
  if (row.httpStatus != null && row.httpStatus >= 400 && row.httpStatus < 500) issues.push("client_error");
  if (row.httpStatus != null && row.httpStatus >= 500) issues.push("server_error");
  if (row.httpStatus != null && row.httpStatus >= 300 && row.httpStatus < 400) issues.push("redirect");
  if (!row.title) issues.push("missing_title");
  if (row.title && row.title.length > 60) issues.push("title_too_long");
  if (!row.metaDesc) issues.push("missing_meta_description");
  if (row.metaDesc && row.metaDesc.length > 160) issues.push("meta_description_too_long");
  if (row.h1Count === 0) issues.push("missing_h1");
  if (!row.canonicalUrl) issues.push("missing_canonical");
  if (row.imgMissingAltCount > 0) issues.push("images_missing_alt");
  if (hasRobotsNoindex(row.robotsMeta, row.xRobotsTag)) issues.push("noindex_directive");
  if (
    row.responseTimeMs != null &&
    row.responseTimeMs >= 5000 &&
    row.httpStatus != null &&
    row.httpStatus >= 200 &&
    row.httpStatus < 300
  ) {
    issues.push("slow_response");
  }
  return issues;
}

function toDelimited(rows: Array<Record<string, unknown>>, delimiter: "," | "\t") {
  const headers = Object.keys(rows[0] ?? {});
  const escape = (v: unknown) => {
    const raw = String(v ?? "");
    if (delimiter === "\t") return raw.replace(/\t/g, " ");
    if (raw.includes("\"") || raw.includes(",") || raw.includes("\n")) {
      return `"${raw.replace(/"/g, "\"\"")}"`;
    }
    return raw;
  };
  const lines = [headers.join(delimiter)];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(delimiter));
  }
  return lines.join("\n");
}

function normalizeDupKey(raw: string) {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeForSimilarity(raw: string) {
  return normalizeDupKey(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function robotsDirectivesLower(meta: string | null, xRobots: string | null): string {
  return `${meta ?? ""} ${xRobots ?? ""}`.toLowerCase();
}

function hasRobotsNoindex(meta: string | null, xRobots: string | null): boolean {
  const c = robotsDirectivesLower(meta, xRobots);
  return c.includes("noindex") || c.includes("none");
}

function hasRestrictiveRobotsDirectives(meta: string | null, xRobots: string | null): boolean {
  const c = robotsDirectivesLower(meta, xRobots);
  return c.includes("noindex") || c.includes("nofollow") || c.includes("none");
}

function robotsDirectiveTokens(meta: string | null, xRobots: string | null): string[] {
  const combined = [meta, xRobots].filter((s) => s && String(s).trim()).join(",");
  return !combined
    ? []
    : combined
        .toLowerCase()
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

export async function GET(req: Request, ctx: RouteCtx) {
  const { id: jobId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "excel" ? "excel" : "csv";
  const report = searchParams.get("report") ?? "issues";
  const queueRows = await prisma.crawlQueue.findMany({
    where: { jobId },
    select: { urlHash: true, url: true, discoveredFromUrlHash: true, depth: true, state: true },
  });

  let audits: Awaited<ReturnType<typeof prisma.crawlPageAudit.findMany>>;
  try {
    audits = await prisma.crawlPageAudit.findMany({
      where: { jobId },
      orderBy: [{ depth: "asc" }, { fetchedAt: "desc" }],
    });
  } catch (err) {
    if (!String(err).includes("CrawlPageAudit")) throw err;
    audits = [];
  }

  if (report === "summary") {
    const broken = audits.filter((a) => a.httpStatus != null && a.httpStatus >= 400).length;
    const redirects = audits.filter((a) => a.httpStatus != null && a.httpStatus >= 300 && a.httpStatus < 400).length;
    const missingTitles = audits.filter((a) => !a.title).length;
    const missingMetaDescriptions = audits.filter((a) => !a.metaDesc).length;
    const missingH1 = audits.filter((a) => a.h1Count === 0).length;
    const exactDuplicates = audits.filter(
      (a) =>
        a.contentHash &&
        audits.some((b) => b.id !== a.id && b.contentHash != null && b.contentHash === a.contentHash),
    ).length;

    // Duplicate title / meta description: count URLs that are part of duplicate groups.
    let duplicateTitles = 0;
    const titlesByKey = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.title) continue;
      const key = normalizeDupKey(a.title);
      if (!key) continue;
      const arr = titlesByKey.get(key) ?? [];
      arr.push(a);
      titlesByKey.set(key, arr);
    }
    for (const arr of titlesByKey.values()) {
      if (arr.length >= 2) duplicateTitles += arr.length;
    }

    let duplicateMetaDescriptions = 0;
    const metaByKey = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.metaDesc) continue;
      const key = normalizeDupKey(a.metaDesc);
      if (!key) continue;
      const arr = metaByKey.get(key) ?? [];
      arr.push(a);
      metaByKey.set(key, arr);
    }
    for (const arr of metaByKey.values()) {
      if (arr.length >= 2) duplicateMetaDescriptions += arr.length;
    }

    // Near-duplicate count based on title + meta-description token similarity.
    const nearDupUrlHashes = new Set<string>();
    const docs = audits
      .map((a) => ({
        urlHash: a.urlHash,
        tokens: new Set(
          tokenizeForSimilarity(`${a.title ?? ""} ${a.metaDesc ?? ""}`).slice(0, 256),
        ),
      }))
      .filter((d) => d.tokens.size >= 8);
    const docsLimit = Math.min(docs.length, 1200);
    for (let i = 0; i < docsLimit; i++) {
      for (let j = i + 1; j < docsLimit; j++) {
        const score = jaccardSimilarity(docs[i].tokens, docs[j].tokens);
        if (score >= 0.8) {
          nearDupUrlHashes.add(docs[i].urlHash);
          nearDupUrlHashes.add(docs[j].urlHash);
        }
      }
    }
    const nearDuplicates = nearDupUrlHashes.size;
    const canonicalIssues = audits.filter((a) => {
      if (!a.canonicalUrl) return true;
      try {
        const page = new URL(a.url);
        const canonical = new URL(a.canonicalUrl, a.url);
        // Same URL except trailing slash differences are acceptable.
        const normalize = (u: URL) =>
          `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
        return normalize(page) !== normalize(canonical);
      } catch {
        return true;
      }
    }).length;
    const headingIssues = audits.filter(
      (a) => a.h1Count === 0 || a.h1Count > 1 || a.h2Count === 0,
    ).length;
    const inlinksByHash = new Map<string, number>();
    for (const q of queueRows) {
      if (!q.discoveredFromUrlHash) continue;
      inlinksByHash.set(q.urlHash, (inlinksByHash.get(q.urlHash) ?? 0) + 1);
    }
    const orphanPages = queueRows.filter(
      (q) => q.depth > 0 && (inlinksByHash.get(q.urlHash) ?? 0) === 0,
    ).length;
    const urlIssues = queueRows.filter((q) => {
      try {
        const u = new URL(q.url);
        const full = u.toString();
        const path = u.pathname;
        const issues =
          /[A-Z]/.test(full) ||
          path.includes("_") ||
          u.search.length > 0 ||
          /[^\x00-\x7F]/.test(full) ||
          full.length > 120 ||
          /\/\/{2,}/.test(path);
        return issues;
      } catch {
        return true;
      }
    }).length;
    const directivesIssues = audits.filter((a) =>
      hasRestrictiveRobotsDirectives(a.robotsMeta, a.xRobotsTag),
    ).length;
    const hreflangIssues = audits.filter((a) => a.hreflangCount === 0).length;
    const indexableUrls = audits.filter((a) => {
      const hasNoindex = hasRobotsNoindex(a.robotsMeta, a.xRobotsTag);
      const okStatus = a.httpStatus == null || (a.httpStatus >= 200 && a.httpStatus < 300);
      return okStatus && !hasNoindex;
    }).length;
    const pagesWithJsonLd = audits.filter((a) => a.jsonLdCount > 0).length;
    const robotsTxtBlocked = audits.filter((a) => a.fetchError === "robots_disallowed").length;
    const timings = audits
      .map((a) => a.responseTimeMs)
      .filter((ms): ms is number => ms != null && ms >= 0);
    const avgResponseTimeMs =
      timings.length > 0 ? Math.round(timings.reduce((s, n) => s + n, 0) / timings.length) : 0;
    const slowResponsePages = audits.filter(
      (a) =>
        a.responseTimeMs != null &&
        a.responseTimeMs >= 3000 &&
        a.httpStatus != null &&
        a.httpStatus >= 200 &&
        a.httpStatus < 300,
    ).length;
    const pagesWithExternalLinks = audits.filter((a) => a.linksExternalCount > 0).length;
    const securityIssues = audits.filter((a) => {
      const issues: string[] = [];
      try {
        const u = new URL(a.url);
        if (u.protocol !== "https:") issues.push("insecure_http_url");
        for (const key of u.searchParams.keys()) {
          const k = key.toLowerCase();
          if (k.includes("token") || k.includes("password") || k.includes("secret") || k.includes("key")) {
            issues.push("sensitive_query_param");
            break;
          }
        }
      } catch {
        issues.push("invalid_url");
      }
      if (a.canonicalUrl) {
        try {
          const c = new URL(a.canonicalUrl, a.url);
          if (c.protocol !== "https:") issues.push("insecure_canonical");
        } catch {
          issues.push("invalid_canonical");
        }
      }
      return issues.length > 0;
    }).length;
    const contentQualityIssues = audits.filter((a) => {
      const issues: string[] = [];
      if ((a.wordCount ?? 0) < 150) issues.push("thin_content");
      if (!a.title) issues.push("missing_title");
      if (!a.metaDesc) issues.push("missing_meta_description");
      if ((a.title?.length ?? 0) > 60) issues.push("title_too_long");
      if ((a.metaDesc?.length ?? 0) > 160) issues.push("meta_description_too_long");
      return issues.length > 0;
    }).length;
    const brokenLinksWithSources = audits.filter(
      (a) => (a.httpStatus ?? 0) >= 400 && queueRows.some((q) => q.urlHash === a.urlHash && !!q.discoveredFromUrlHash),
    ).length;
    const redirectChainIssues = await prisma.urlFetch.count({
      where: { jobId, redirectHops: { gte: 2 } },
    });
    const pagesWithMissingImageAlt = audits.filter((a) => a.imgMissingAltCount > 0).length;
    const totalImagesMissingAlt = audits.reduce((s, a) => s + a.imgMissingAltCount, 0);

    return NextResponse.json({
      jobId,
      totals: {
        urls: audits.length,
        broken,
        redirects,
        missingTitles,
        missingMetaDescriptions,
        missingH1,
        exactDuplicates,
        duplicateTitles,
        duplicateMetaDescriptions,
        nearDuplicates,
        canonicalIssues,
        headingIssues,
        orphanPages,
        urlIssues,
        directivesIssues,
        hreflangIssues,
        indexableUrls,
        securityIssues,
        contentQualityIssues,
        brokenLinksWithSources,
        redirectChainIssues,
        pagesWithMissingImageAlt,
        totalImagesMissingAlt,
        pagesWithJsonLd,
        robotsTxtBlocked,
        avgResponseTimeMs,
        slowResponsePages,
        pagesWithExternalLinks,
      },
    });
  }

  let rows: Array<Record<string, unknown>> = [];

  if (report === "pages") {
    rows = audits.map((a) => ({
      url: a.url,
      depth: a.depth,
      http_status: a.httpStatus,
      content_type: a.contentType,
      title: a.title,
      title_length: a.titleLength,
      meta_description: a.metaDesc,
      meta_description_length: a.metaDescLength,
      h1_count: a.h1Count,
      h2_count: a.h2Count,
      canonical_url: a.canonicalUrl,
      robots_meta: a.robotsMeta,
      x_robots_tag: a.xRobotsTag,
      hreflang_count: a.hreflangCount,
      json_ld_count: a.jsonLdCount,
      json_ld_types: a.jsonLdTypesSummary,
      links_out_count: a.linksOutCount,
      links_external_count: a.linksExternalCount,
      response_time_ms: a.responseTimeMs,
      img_count: a.imgCount,
      img_missing_alt_count: a.imgMissingAltCount,
      word_count: a.wordCount,
      fetched_at: a.fetchedAt.toISOString(),
      fetch_error: a.fetchError,
    }));
  } else if (report === "duplicates") {
    const rowsOut: Array<Record<string, unknown>> = [];
    // Keep a stable schema for CSV/Excel by always emitting the same columns.
    const pushRow = (r: {
      type: string;
      duplicate_key: string;
      group_size: number;
      url: string;
      depth: number;
      http_status: number | null;
      title: string | null;
      meta_description: string | null;
      content_hash: string | null;
    }) => {
      rowsOut.push(r);
    };

    // 1) Exact duplicates by content hash
    const byHash = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.contentHash) continue;
      const arr = byHash.get(a.contentHash) ?? [];
      arr.push(a);
      byHash.set(a.contentHash, arr);
    }
    for (const [hash, list] of byHash) {
      if (list.length < 2) continue;
      for (const row of list) {
        pushRow({
          type: "exact_content",
          duplicate_key: hash,
          group_size: list.length,
          url: row.url,
          depth: row.depth,
          http_status: row.httpStatus ?? null,
          title: row.title,
          meta_description: row.metaDesc,
          content_hash: hash,
        });
      }
    }

    // 2) Duplicate titles
    const byTitle = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.title) continue;
      const key = normalizeDupKey(a.title);
      if (!key) continue;
      const arr = byTitle.get(key) ?? [];
      arr.push(a);
      byTitle.set(key, arr);
    }
    for (const [key, list] of byTitle) {
      if (list.length < 2) continue;
      for (const row of list) {
        pushRow({
          type: "duplicate_title",
          duplicate_key: key,
          group_size: list.length,
          url: row.url,
          depth: row.depth,
          http_status: row.httpStatus ?? null,
          title: row.title,
          meta_description: row.metaDesc,
          content_hash: row.contentHash ?? null,
        });
      }
    }

    // 3) Duplicate meta descriptions
    const byMeta = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.metaDesc) continue;
      const key = normalizeDupKey(a.metaDesc);
      if (!key) continue;
      const arr = byMeta.get(key) ?? [];
      arr.push(a);
      byMeta.set(key, arr);
    }
    for (const [key, list] of byMeta) {
      if (list.length < 2) continue;
      for (const row of list) {
        pushRow({
          type: "duplicate_meta_description",
          duplicate_key: key,
          group_size: list.length,
          url: row.url,
          depth: row.depth,
          http_status: row.httpStatus ?? null,
          title: row.title,
          meta_description: row.metaDesc,
          content_hash: row.contentHash ?? null,
        });
      }
    }

    rows = rowsOut;
  } else if (report === "redirects") {
    const fetches = await prisma.urlFetch.findMany({
      where: { jobId },
      orderBy: { requestedAt: "asc" },
      select: {
        requestedUrl: true,
        httpStatus: true,
        redirectHops: true,
        redirectChain: true,
        contentType: true,
        finishedAt: true,
        url: { select: { url: true } },
      },
    });

    rows = fetches.map((f) => ({
      requested_url: f.requestedUrl,
      final_url: f.url?.url ?? null,
      http_status: f.httpStatus,
      redirect_hops: f.redirectHops,
      redirect_chain: f.redirectChain,
      content_type: f.contentType,
      fetched_at: f.finishedAt?.toISOString() ?? null,
    }));
  } else if (report === "duplicate_titles") {
    const byTitle = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.title) continue;
      const key = normalizeDupKey(a.title);
      if (!key) continue;
      const arr = byTitle.get(key) ?? [];
      arr.push(a);
      byTitle.set(key, arr);
    }
    for (const [key, list] of byTitle) {
      if (list.length < 2) continue;
      for (const row of list) {
        rows.push({
          duplicate_title_key: key,
          duplicate_group_size: list.length,
          url: row.url,
          depth: row.depth,
          http_status: row.httpStatus,
          title: row.title,
          meta_description: row.metaDesc,
        });
      }
    }
  } else if (report === "duplicate_meta_descriptions") {
    const byMeta = new Map<string, typeof audits>();
    for (const a of audits) {
      if (!a.metaDesc) continue;
      const key = normalizeDupKey(a.metaDesc);
      if (!key) continue;
      const arr = byMeta.get(key) ?? [];
      arr.push(a);
      byMeta.set(key, arr);
    }
    for (const [key, list] of byMeta) {
      if (list.length < 2) continue;
      for (const row of list) {
        rows.push({
          duplicate_meta_description_key: key,
          duplicate_group_size: list.length,
          url: row.url,
          depth: row.depth,
          http_status: row.httpStatus,
          title: row.title,
          meta_description: row.metaDesc,
        });
      }
    }
  } else if (report === "near_duplicates") {
    const docs = audits
      .map((a) => ({
        url: a.url,
        depth: a.depth,
        httpStatus: a.httpStatus,
        title: a.title,
        metaDesc: a.metaDesc,
        tokenCount: tokenizeForSimilarity(`${a.title ?? ""} ${a.metaDesc ?? ""}`).length,
        tokenSet: new Set(
          tokenizeForSimilarity(`${a.title ?? ""} ${a.metaDesc ?? ""}`).slice(0, 256),
        ),
      }))
      .filter((d) => d.tokenSet.size >= 8);

    const limit = Math.min(docs.length, 1200);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        const similarity = jaccardSimilarity(docs[i].tokenSet, docs[j].tokenSet);
        if (similarity < 0.8) continue;
        rows.push({
          similarity: Number(similarity.toFixed(3)),
          url_a: docs[i].url,
          depth_a: docs[i].depth,
          http_status_a: docs[i].httpStatus,
          title_a: docs[i].title,
          meta_description_a: docs[i].metaDesc,
          token_count_a: docs[i].tokenCount,
          url_b: docs[j].url,
          depth_b: docs[j].depth,
          http_status_b: docs[j].httpStatus,
          title_b: docs[j].title,
          meta_description_b: docs[j].metaDesc,
          token_count_b: docs[j].tokenCount,
          method: "title_meta_jaccard",
        });
      }
    }
  } else if (report === "canonical_audit") {
    rows = audits.map((a) => {
      let canonicalStatus: "missing" | "self" | "non_self" | "invalid" = "missing";
      let canonicalResolved: string | null = null;
      let issue: string | null = "missing_canonical";

      if (a.canonicalUrl) {
        try {
          const page = new URL(a.url);
          const canonical = new URL(a.canonicalUrl, a.url);
          canonicalResolved = canonical.toString();
          const normalize = (u: URL) =>
            `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
          if (normalize(page) === normalize(canonical)) {
            canonicalStatus = "self";
            issue = null;
          } else {
            canonicalStatus = "non_self";
            issue = "canonical_points_elsewhere";
          }
        } catch {
          canonicalStatus = "invalid";
          issue = "canonical_invalid_url";
        }
      }

      return {
        url: a.url,
        depth: a.depth,
        http_status: a.httpStatus,
        canonical_raw: a.canonicalUrl,
        canonical_resolved: canonicalResolved,
        canonical_status: canonicalStatus,
        issue,
      };
    });
  } else if (report === "heading_audit") {
    rows = audits.map((a) => {
      const issues: string[] = [];
      if (a.h1Count === 0) issues.push("missing_h1");
      if (a.h1Count > 1) issues.push("multiple_h1");
      if (a.h2Count === 0) issues.push("missing_h2");
      return {
        url: a.url,
        depth: a.depth,
        http_status: a.httpStatus,
        h1_count: a.h1Count,
        h2_count: a.h2Count,
        title: a.title,
        title_length: a.titleLength,
        meta_description_length: a.metaDescLength,
        heading_issue_count: issues.length,
        heading_issues: issues.join("|"),
      };
    });
  } else if (report === "site_structure") {
    const inlinksByHash = new Map<string, number>();
    for (const q of queueRows) {
      if (!q.discoveredFromUrlHash) continue;
      inlinksByHash.set(q.urlHash, (inlinksByHash.get(q.urlHash) ?? 0) + 1);
    }

    const auditByHash = new Map(audits.map((a) => [a.urlHash, a]));
    const normalizePathDepth = (rawUrl: string) => {
      try {
        const u = new URL(rawUrl);
        return u.pathname.split("/").filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    rows = queueRows.map((q) => {
      const audit = auditByHash.get(q.urlHash);
      const inlinks = inlinksByHash.get(q.urlHash) ?? 0;
      const outlinks = audit?.linksOutCount ?? 0;
      // Simple crawl-native importance score: more inlinks and shallower depth rank higher.
      const internalLinkScore = Number(
        (
          (Math.log2(inlinks + 1) * 3 + Math.log2(outlinks + 1) * 1.2 + 1 / (q.depth + 1)) *
          10
        ).toFixed(3),
      );
      return {
        url: q.url,
        crawl_depth: q.depth,
        path_depth: normalizePathDepth(q.url),
        inlinks,
        outlinks,
        internal_link_score: internalLinkScore,
        http_status: audit?.httpStatus ?? null,
        title: audit?.title ?? null,
        queue_state: q.state,
        is_orphan_like: q.depth > 0 && inlinks === 0,
      };
    });
  } else if (report === "url_issues") {
    rows = queueRows.map((q) => {
      const issues: string[] = [];
      try {
        const u = new URL(q.url);
        const full = u.toString();
        const path = u.pathname;
        if (/[A-Z]/.test(full)) issues.push("uppercase_characters");
        if (path.includes("_")) issues.push("underscore_in_path");
        if (u.search.length > 0) issues.push("has_parameters");
        if (/[^\x00-\x7F]/.test(full)) issues.push("non_ascii_characters");
        if (full.length > 120) issues.push("long_url");
        if (/\/\/{2,}/.test(path)) issues.push("repeated_path_segments");
        return {
          url: q.url,
          crawl_depth: q.depth,
          url_length: full.length,
          has_query_params: u.search.length > 0,
          query_param_count: u.searchParams.size,
          issue_count: issues.length,
          issues: issues.join("|"),
        };
      } catch {
        return {
          url: q.url,
          crawl_depth: q.depth,
          url_length: q.url.length,
          has_query_params: null,
          query_param_count: null,
          issue_count: 1,
          issues: "invalid_url",
        };
      }
    });
  } else if (report === "directives_audit") {
    rows = audits.map((a) => {
      const directives = robotsDirectiveTokens(a.robotsMeta, a.xRobotsTag);
      const hasNoindex = hasRobotsNoindex(a.robotsMeta, a.xRobotsTag);
      const directivesLower = robotsDirectivesLower(a.robotsMeta, a.xRobotsTag);
      const hasNofollow = directivesLower.includes("nofollow") || directivesLower.includes("none");
      return {
        url: a.url,
        depth: a.depth,
        http_status: a.httpStatus,
        robots_meta: a.robotsMeta || null,
        x_robots_tag: a.xRobotsTag || null,
        directives: directives.join("|"),
        has_noindex: hasNoindex,
        has_nofollow: hasNofollow,
        is_indexable_candidate:
          !hasNoindex && (a.httpStatus == null || (a.httpStatus >= 200 && a.httpStatus < 300)),
        issue_count: Number(hasNoindex) + Number(hasNofollow),
      };
    });
  } else if (report === "security_audit") {
    rows = audits.map((a) => {
      const issues: string[] = [];
      let scheme: string | null = null;
      let hasSensitiveQueryParams = false;
      try {
        const u = new URL(a.url);
        scheme = u.protocol.replace(":", "");
        if (u.protocol !== "https:") issues.push("insecure_http_url");
        for (const key of u.searchParams.keys()) {
          const k = key.toLowerCase();
          if (k.includes("token") || k.includes("password") || k.includes("secret") || k.includes("key")) {
            hasSensitiveQueryParams = true;
            issues.push("sensitive_query_param");
            break;
          }
        }
      } catch {
        issues.push("invalid_url");
      }
      if (a.canonicalUrl) {
        try {
          const c = new URL(a.canonicalUrl, a.url);
          if (c.protocol !== "https:") issues.push("insecure_canonical");
        } catch {
          issues.push("invalid_canonical");
        }
      }
      return {
        url: a.url,
        depth: a.depth,
        http_status: a.httpStatus,
        scheme,
        canonical_url: a.canonicalUrl,
        has_sensitive_query_params: hasSensitiveQueryParams,
        issue_count: issues.length,
        issues: issues.join("|"),
      };
    });
  } else if (report === "content_quality") {
    rows = audits.map((a) => {
      const issues: string[] = [];
      if ((a.wordCount ?? 0) < 150) issues.push("thin_content");
      if (!a.title) issues.push("missing_title");
      if (!a.metaDesc) issues.push("missing_meta_description");
      if ((a.title?.length ?? 0) > 60) issues.push("title_too_long");
      if ((a.metaDesc?.length ?? 0) > 160) issues.push("meta_description_too_long");
      return {
        url: a.url,
        depth: a.depth,
        http_status: a.httpStatus,
        word_count: a.wordCount,
        title: a.title,
        title_length: a.titleLength,
        meta_description: a.metaDesc,
        meta_description_length: a.metaDescLength,
        issue_count: issues.length,
        issues: issues.join("|"),
      };
    });
  } else if (report === "broken_links") {
    const queueByHash = new Map(queueRows.map((q) => [q.urlHash, q]));
    const sourceUrlByHash = new Map(queueRows.map((q) => [q.urlHash, q.url]));
    rows = audits
      .filter((a) => (a.httpStatus ?? 0) >= 400)
      .map((a) => {
        const queue = queueByHash.get(a.urlHash);
        const sourceHash = queue?.discoveredFromUrlHash ?? null;
        const sourceUrl = sourceHash ? sourceUrlByHash.get(sourceHash) ?? null : null;
        return {
          broken_url: a.url,
          http_status: a.httpStatus,
          depth: a.depth,
          source_url: sourceUrl,
          source_url_hash: sourceHash,
          title: a.title,
          fetch_error: a.fetchError,
        };
      });
  } else if (report === "redirect_chains") {
    const fetches = await prisma.urlFetch.findMany({
      where: { jobId, redirectHops: { gte: 1 } },
      select: {
        id: true,
        requestedUrl: true,
        httpStatus: true,
        redirectHops: true,
        finishedAt: true,
      },
      orderBy: { requestedAt: "asc" },
    });
    const fetchIds = fetches.map((f) => f.id);
    const redirects = fetchIds.length
      ? await prisma.redirect.findMany({
          where: { fetchId: { in: fetchIds } },
          orderBy: [{ fetchId: "asc" }, { hopOrder: "asc" }],
          select: {
            fetchId: true,
            hopOrder: true,
            fromUrl: true,
            toUrl: true,
            statusCode: true,
          },
        })
      : [];
    const redirectsByFetch = new Map<string, typeof redirects>();
    for (const r of redirects) {
      const arr = redirectsByFetch.get(r.fetchId) ?? [];
      arr.push(r);
      redirectsByFetch.set(r.fetchId, arr);
    }
    const chainRows: Array<Record<string, unknown>> = [];
    for (const f of fetches) {
      const hops = redirectsByFetch.get(f.id) ?? [];
      if (hops.length === 0) {
        chainRows.push({
          requested_url: f.requestedUrl,
          final_http_status: f.httpStatus,
          redirect_hops: f.redirectHops ?? 0,
          chain_type: (f.redirectHops ?? 0) >= 2 ? "multi_hop" : "single_hop",
          hop_order: null,
          from_url: null,
          to_url: null,
          hop_status_code: null,
          fetched_at: f.finishedAt?.toISOString() ?? null,
        });
        continue;
      }
      for (const h of hops) {
        chainRows.push({
          requested_url: f.requestedUrl,
          final_http_status: f.httpStatus,
          redirect_hops: f.redirectHops ?? 0,
          chain_type: (f.redirectHops ?? 0) >= 2 ? "multi_hop" : "single_hop",
          hop_order: h.hopOrder,
          from_url: h.fromUrl,
          to_url: h.toUrl,
          hop_status_code: h.statusCode,
          fetched_at: f.finishedAt?.toISOString() ?? null,
        });
      }
    }
    rows = chainRows;
  } else if (report === "performance") {
    rows = audits.map((a) => ({
      url: a.url,
      depth: a.depth,
      http_status: a.httpStatus,
      content_type: a.contentType,
      response_time_ms: a.responseTimeMs,
      links_out_count: a.linksOutCount,
      links_external_count: a.linksExternalCount,
      word_count: a.wordCount,
    }));
  } else if (report === "robots_blocked") {
    rows = audits
      .filter((a) => a.fetchError === "robots_disallowed")
      .map((a) => ({
        url: a.url,
        depth: a.depth,
        fetch_error: a.fetchError,
      }));
  } else if (report === "structured_data") {
    rows = audits.map((a) => ({
      url: a.url,
      depth: a.depth,
      http_status: a.httpStatus,
      content_type: a.contentType,
      json_ld_block_count: a.jsonLdCount,
      json_ld_types: a.jsonLdTypesSummary,
      robots_meta: a.robotsMeta,
      x_robots_tag: a.xRobotsTag,
      has_noindex: hasRobotsNoindex(a.robotsMeta, a.xRobotsTag),
    }));
  } else if (report === "images") {
    rows = audits.map((a) => ({
      url: a.url,
      depth: a.depth,
      http_status: a.httpStatus,
      content_type: a.contentType,
      img_count: a.imgCount,
      img_missing_alt_count: a.imgMissingAltCount,
      title: a.title,
      issue: a.imgMissingAltCount > 0 ? "missing_alt_on_image" : null,
    }));
  } else if (report === "hreflang_audit") {
    rows = audits.map((a) => ({
      url: a.url,
      depth: a.depth,
      http_status: a.httpStatus,
      hreflang_count: a.hreflangCount,
      has_hreflang: a.hreflangCount > 0,
      issue: a.hreflangCount > 0 ? null : "missing_hreflang",
      title: a.title,
      canonical_url: a.canonicalUrl,
    }));
  } else {
    rows = audits
      .map((a) => {
        const issues = classifyIssues(a);
        return {
          url: a.url,
          depth: a.depth,
          http_status: a.httpStatus,
          is_broken: a.httpStatus != null && a.httpStatus >= 400,
          is_redirect: a.httpStatus != null && a.httpStatus >= 300 && a.httpStatus < 400,
          has_non_2xx: hasNon2xx(a.httpStatus),
          title: a.title,
          title_length: a.titleLength,
          meta_description: a.metaDesc,
          meta_description_length: a.metaDescLength,
          h1_count: a.h1Count,
          canonical_url: a.canonicalUrl,
          fetch_error: a.fetchError,
          issues: issues.join("|"),
        };
      })
      .filter((r) => String(r.issues).length > 0 || r.has_non_2xx || r.fetch_error);
  }

  if (format === "excel") {
    const content = toDelimited(rows, "\t");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "content-type": "application/vnd.ms-excel; charset=utf-8",
        "content-disposition": `attachment; filename="${report}-${jobId}.xls"`,
      },
    });
  }

  const csv = toDelimited(rows, ",");
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${report}-${jobId}.csv"`,
    },
  });
}
