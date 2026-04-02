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

  // Determine change kind/changed_fields for completeness.
  let change_kind: "new_in_b" | "removed_in_a" | "changed";
  let changed_fields = "";

  const row = {
    change_kind: "" as "new_in_b" | "removed_in_a" | "changed",
    changed_fields,
    url,
    depth_a: auditA ? auditA.depth : "",
    depth_b: auditB ? auditB.depth : "",
    http_status_a: auditA ? auditA.httpStatus ?? "" : "",
    http_status_b: auditB ? auditB.httpStatus ?? "" : "",
    title_a: normStr(auditA?.title),
    title_b: normStr(auditB?.title),
    canonical_a: normStr(auditA?.canonicalUrl),
    canonical_b: normStr(auditB?.canonicalUrl),
    meta_description_a: normStr(auditA?.metaDesc),
    meta_description_b: normStr(auditB?.metaDesc),
    word_count_a: auditA ? auditA.wordCount : "",
    word_count_b: auditB ? auditB.wordCount : "",
    h1_text_a: normStr(auditA?.h1Text),
    h1_text_b: normStr(auditB?.h1Text),
    h1_count_a: auditA ? auditA.h1Count : "",
    h1_count_b: auditB ? auditB.h1Count : "",
    content_type_a: normStr(auditA?.contentType),
    content_type_b: normStr(auditB?.contentType),
    robots_meta_a: normStr(auditA?.robotsMeta),
    robots_meta_b: normStr(auditB?.robotsMeta),
    meta_refresh_a: normStr(auditA?.metaRefreshContent),
    meta_refresh_b: normStr(auditB?.metaRefreshContent),
    content_hash_a: normStr(auditA?.contentHash),
    content_hash_b: normStr(auditB?.contentHash),
    x_robots_tag_a: normStr(auditA?.xRobotsTag),
    x_robots_tag_b: normStr(auditB?.xRobotsTag),
    html_lang_a: normStr(auditA?.htmlLang),
    html_lang_b: normStr(auditB?.htmlLang),
    response_time_ms_a: auditA ? auditA.responseTimeMs ?? "" : "",
    response_time_ms_b: auditB ? auditB.responseTimeMs ?? "" : "",
  } as Record<string, string | number>;

  if (auditA && !auditB) {
    change_kind = "removed_in_a";
  } else if (!auditA && auditB) {
    change_kind = "new_in_b";
  } else {
    const ra = auditA!;
    const rb = auditB!;

    const statusDiff = ra.httpStatus !== rb.httpStatus;
    const titleDiff = normStr(ra.title) !== normStr(rb.title);
    const canDiff = normStr(ra.canonicalUrl) !== normStr(rb.canonicalUrl);
    const metaDiff = normStr(ra.metaDesc) !== normStr(rb.metaDesc);
    const wordDiff = ra.wordCount !== rb.wordCount;
    const h1TextDiff = normStr(ra.h1Text) !== normStr(rb.h1Text);
    const h1CountDiff = ra.h1Count !== rb.h1Count;
    const contentTypeDiff = normStr(ra.contentType) !== normStr(rb.contentType);
    const robotsDiff = normStr(ra.robotsMeta) !== normStr(rb.robotsMeta);
    const metaRefreshDiff = normStr(ra.metaRefreshContent) !== normStr(rb.metaRefreshContent);
    const contentHashDiff = normStr(ra.contentHash) !== normStr(rb.contentHash);
    const xRobotsDiff = normStr(ra.xRobotsTag) !== normStr(rb.xRobotsTag);
    const htmlLangDiff = normStr(ra.htmlLang) !== normStr(rb.htmlLang);
    const responseTimeDiff = ra.responseTimeMs !== rb.responseTimeMs;

    const fields: string[] = [];
    if (statusDiff) fields.push("status");
    if (titleDiff) fields.push("title");
    if (canDiff) fields.push("canonical");
    if (metaDiff) fields.push("meta_description");
    if (wordDiff) fields.push("word_count");
    if (h1TextDiff) fields.push("h1_text");
    if (h1CountDiff) fields.push("h1_count");
    if (contentTypeDiff) fields.push("content_type");
    if (robotsDiff) fields.push("robots_meta");
    if (metaRefreshDiff) fields.push("meta_refresh");
    if (contentHashDiff) fields.push("content_hash");
    if (xRobotsDiff) fields.push("x_robots_tag");
    if (htmlLangDiff) fields.push("html_lang");
    if (responseTimeDiff) fields.push("response_time_ms");

    change_kind = "changed";
    changed_fields = fields.join("|");
    row.changed_fields = changed_fields;
  }

  row.change_kind = change_kind;
  return NextResponse.json({ row });
}

