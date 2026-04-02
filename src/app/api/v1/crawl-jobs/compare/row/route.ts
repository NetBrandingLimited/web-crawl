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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobA = searchParams.get("a");
  const jobB = searchParams.get("b");
  const urlHash = searchParams.get("url_hash") ?? searchParams.get("urlHash");

  if (!jobA || !jobB || !urlHash) {
    return NextResponse.json(
      { error: "missing_params", message: "Provide query params a, b, and url_hash." },
      { status: 400 },
    );
  }
  if (jobA === jobB) {
    return NextResponse.json(
      { error: "same_job", message: "Baseline job (a) and compare job (b) must be different." },
      { status: 400 },
    );
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

  const [auditA, auditB] = await Promise.all([
    prisma.crawlPageAudit.findFirst({ where: { jobId: jobA, urlHash }, select }) as unknown as AuditRow | null,
    prisma.crawlPageAudit.findFirst({ where: { jobId: jobB, urlHash }, select }) as unknown as AuditRow | null,
  ]);

  if (!auditA && !auditB) {
    return NextResponse.json({ error: "not_found", message: "No audit row found for that url_hash." }, { status: 404 });
  }

  const url = (auditA ?? auditB)!.url;

  if (auditA && !auditB) {
    const ra = auditA;
    const row: Record<string, string | number> = {
      change_kind: "removed_in_a",
      changed_fields: "",
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
    return NextResponse.json({ row });
  }

  if (!auditA && auditB) {
    const rb = auditB;
    const row: Record<string, string | number> = {
      change_kind: "new_in_b",
      changed_fields: "",
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
    return NextResponse.json({ row });
  }

  // changed
  const ra = auditA!;
  const rb = auditB!;

  // Normalize/trim once per side.
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

  // Build `changed_fields` without allocating `string[]`.
  let changed_fields = "";
  const push = (token: string) => {
    changed_fields = changed_fields === "" ? token : `${changed_fields}|${token}`;
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

  const row: Record<string, string | number> = {
    change_kind: "changed",
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

  return NextResponse.json({ row });
}

