import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type AuditRow = {
  urlHash: string;
  url: string;
  depth: number;
  httpStatus: number | null;
  title: string | null;
  canonicalUrl: string | null;
  metaDesc: string | null;
  wordCount: number;
  h1Text: string | null;
  h1Count: number;
  contentType: string | null;
  robotsMeta: string | null;
  metaRefreshContent: string | null;
  contentHash: string | null;
  xRobotsTag: string | null;
  htmlLang: string | null;
  responseTimeMs: number | null;
};

function normStr(v: string | null | undefined) {
  if (v == null) return "";
  return v.trim();
}

function auditsToMap(rows: AuditRow[]) {
  const m = new Map<string, AuditRow>();
  for (const r of rows) m.set(r.urlHash, r);
  return m;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { a?: string; b?: string; url_hashes?: string[] } | null;
  const a = body?.a;
  const b = body?.b;
  const urlHashes = Array.isArray(body?.url_hashes)
    ? body?.url_hashes.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (!a || !b || urlHashes.length === 0) {
    return NextResponse.json({ error: "missing_params", message: "Provide a, b, and url_hashes[] (non-empty)." }, { status: 400 });
  }
  if (a === b) {
    return NextResponse.json({ error: "same_job", message: "Baseline job (a) and compare job (b) must be different." }, { status: 400 });
  }

  const select = {
    urlHash: true,
    url: true,
    depth: true,
    httpStatus: true,
    title: true,
    canonicalUrl: true,
    metaDesc: true,
    wordCount: true,
    h1Text: true,
    h1Count: true,
    contentType: true,
    robotsMeta: true,
    metaRefreshContent: true,
    contentHash: true,
    xRobotsTag: true,
    htmlLang: true,
    responseTimeMs: true,
  } as const;

  const [auditsA, auditsB] = await Promise.all([
    prisma.crawlPageAudit.findMany({
      where: { jobId: a, urlHash: { in: urlHashes } },
      select,
    }),
    prisma.crawlPageAudit.findMany({
      where: { jobId: b, urlHash: { in: urlHashes } },
      select,
    }),
  ]);

  const mapA = auditsToMap(auditsA as AuditRow[]);
  const mapB = auditsToMap(auditsB as AuditRow[]);

  const out: Array<{ url_hash: string; row: Record<string, string | number> }> = [];

  for (const h of urlHashes) {
    const auditA = mapA.get(h);
    const auditB = mapB.get(h);

    if (!auditA && !auditB) {
      // Should not happen for diff rows, but keep response stable.
      out.push({
        url_hash: h,
        row: { change_kind: "changed", changed_fields: "", url: "", depth_a: "", depth_b: "", http_status_a: "", http_status_b: "" },
      });
      continue;
    }

    const url = (auditA ?? auditB)!.url;

    let change_kind: "new_in_b" | "removed_in_a" | "changed";
    let changed_fields = "";
    let row: Record<string, string | number>;

    // new_in_b
    if (!auditA && auditB) {
      const rb = auditB;
      change_kind = "new_in_b";
      changed_fields = "";
      row = {
        change_kind,
        changed_fields,
        url,
        depth_a: "",
        depth_b: rb.depth,
        http_status_a: "",
        http_status_b: rb.httpStatus ?? "",
        title_a: "",
        title_b: normStr(rb.title),
        canonical_a: "",
        canonical_b: normStr(rb.canonicalUrl),
        meta_description_a: "",
        meta_description_b: normStr(rb.metaDesc),
        word_count_a: "",
        word_count_b: rb.wordCount,
        h1_text_a: "",
        h1_text_b: normStr(rb.h1Text),
        h1_count_a: "",
        h1_count_b: rb.h1Count,
        content_type_a: "",
        content_type_b: normStr(rb.contentType),
        robots_meta_a: "",
        robots_meta_b: normStr(rb.robotsMeta),
        meta_refresh_a: "",
        meta_refresh_b: normStr(rb.metaRefreshContent),
        content_hash_a: "",
        content_hash_b: normStr(rb.contentHash),
        x_robots_tag_a: "",
        x_robots_tag_b: normStr(rb.xRobotsTag),
        html_lang_a: "",
        html_lang_b: normStr(rb.htmlLang),
        response_time_ms_a: "",
        response_time_ms_b: rb.responseTimeMs ?? "",
      };
    }
    // removed_in_a
    else if (auditA && !auditB) {
      const ra = auditA;
      change_kind = "removed_in_a";
      changed_fields = "";
      row = {
        change_kind,
        changed_fields,
        url,
        depth_a: ra.depth,
        depth_b: "",
        http_status_a: ra.httpStatus ?? "",
        http_status_b: "",
        title_a: normStr(ra.title),
        title_b: "",
        canonical_a: normStr(ra.canonicalUrl),
        canonical_b: "",
        meta_description_a: normStr(ra.metaDesc),
        meta_description_b: "",
        word_count_a: ra.wordCount,
        word_count_b: "",
        h1_text_a: normStr(ra.h1Text),
        h1_text_b: "",
        h1_count_a: ra.h1Count,
        h1_count_b: "",
        content_type_a: normStr(ra.contentType),
        content_type_b: "",
        robots_meta_a: normStr(ra.robotsMeta),
        robots_meta_b: "",
        meta_refresh_a: normStr(ra.metaRefreshContent),
        meta_refresh_b: "",
        content_hash_a: normStr(ra.contentHash),
        content_hash_b: "",
        x_robots_tag_a: normStr(ra.xRobotsTag),
        x_robots_tag_b: "",
        html_lang_a: normStr(ra.htmlLang),
        html_lang_b: "",
        response_time_ms_a: ra.responseTimeMs ?? "",
        response_time_ms_b: "",
      };
    }
    // changed
    else {
      const ra = auditA!;
      const rb = auditB!;

      change_kind = "changed";

      // Compute normalized (trimmed) strings once per side.
      const titleA = normStr(ra.title);
      const titleB = normStr(rb.title);
      const canonicalA = normStr(ra.canonicalUrl);
      const canonicalB = normStr(rb.canonicalUrl);
      const metaDescA = normStr(ra.metaDesc);
      const metaDescB = normStr(rb.metaDesc);
      const h1TextA = normStr(ra.h1Text);
      const h1TextB = normStr(rb.h1Text);
      const contentTypeA = normStr(ra.contentType);
      const contentTypeB = normStr(rb.contentType);
      const robotsMetaA = normStr(ra.robotsMeta);
      const robotsMetaB = normStr(rb.robotsMeta);
      const metaRefreshA = normStr(ra.metaRefreshContent);
      const metaRefreshB = normStr(rb.metaRefreshContent);
      const contentHashA = normStr(ra.contentHash);
      const contentHashB = normStr(rb.contentHash);
      const xRobotsTagA = normStr(ra.xRobotsTag);
      const xRobotsTagB = normStr(rb.xRobotsTag);
      const htmlLangA = normStr(ra.htmlLang);
      const htmlLangB = normStr(rb.htmlLang);

      const statusDiff = ra.httpStatus !== rb.httpStatus;
      const titleDiff = titleA !== titleB;
      const canDiff = canonicalA !== canonicalB;
      const metaDiff = metaDescA !== metaDescB;
      const wordDiff = ra.wordCount !== rb.wordCount;
      const h1TextDiff = h1TextA !== h1TextB;
      const h1CountDiff = ra.h1Count !== rb.h1Count;
      const contentTypeDiff = contentTypeA !== contentTypeB;
      const robotsDiff = robotsMetaA !== robotsMetaB;
      const metaRefreshDiff = metaRefreshA !== metaRefreshB;
      const contentHashDiff = contentHashA !== contentHashB;
      const xRobotsDiff = xRobotsTagA !== xRobotsTagB;
      const htmlLangDiff = htmlLangA !== htmlLangB;
      const responseTimeDiff = ra.responseTimeMs !== rb.responseTimeMs;

      // Build changed_fields incrementally to avoid allocating an array.
      let outTokens = "";
      const push = (token: string) => {
        outTokens = outTokens === "" ? token : `${outTokens}|${token}`;
      };

      if (statusDiff) push("status");
      if (titleDiff) push("title");
      if (canDiff) push("canonical");
      if (metaDiff) push("meta_description");
      if (wordDiff) push("word_count");
      if (h1TextDiff) push("h1_text");
      if (h1CountDiff) push("h1_count");
      if (contentTypeDiff) push("content_type");
      if (robotsDiff) push("robots_meta");
      if (metaRefreshDiff) push("meta_refresh");
      if (contentHashDiff) push("content_hash");
      if (xRobotsDiff) push("x_robots_tag");
      if (htmlLangDiff) push("html_lang");
      if (responseTimeDiff) push("response_time_ms");

      changed_fields = outTokens;

      row = {
        change_kind,
        changed_fields,
        url,
        depth_a: ra.depth,
        depth_b: rb.depth,
        http_status_a: ra.httpStatus ?? "",
        http_status_b: rb.httpStatus ?? "",
        title_a: titleA,
        title_b: titleB,
        canonical_a: canonicalA,
        canonical_b: canonicalB,
        meta_description_a: metaDescA,
        meta_description_b: metaDescB,
        word_count_a: ra.wordCount,
        word_count_b: rb.wordCount,
        h1_text_a: h1TextA,
        h1_text_b: h1TextB,
        h1_count_a: ra.h1Count,
        h1_count_b: rb.h1Count,
        content_type_a: contentTypeA,
        content_type_b: contentTypeB,
        robots_meta_a: robotsMetaA,
        robots_meta_b: robotsMetaB,
        meta_refresh_a: metaRefreshA,
        meta_refresh_b: metaRefreshB,
        content_hash_a: contentHashA,
        content_hash_b: contentHashB,
        x_robots_tag_a: xRobotsTagA,
        x_robots_tag_b: xRobotsTagB,
        html_lang_a: htmlLangA,
        html_lang_b: htmlLangB,
        response_time_ms_a: ra.responseTimeMs ?? "",
        response_time_ms_b: rb.responseTimeMs ?? "",
      };
    }

    out.push({ url_hash: h, row });
  }

  return NextResponse.json({ rows: out });
}

