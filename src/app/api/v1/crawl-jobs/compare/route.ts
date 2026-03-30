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
};

function normStr(v: string | null | undefined) {
  if (v == null) return "";
  return v.trim();
}

function escapeCsvCell(v: unknown) {
  const raw = String(v ?? "");
  if (raw.includes('"') || raw.includes(",") || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

function auditsToMap(rows: AuditRow[]) {
  const m = new Map<string, AuditRow>();
  for (const r of rows) m.set(r.urlHash, r);
  return m;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobA = searchParams.get("a");
  const jobB = searchParams.get("b");
  const format = searchParams.get("format") === "json" ? "json" : "csv";

  if (!jobA || !jobB) {
    return NextResponse.json({ error: "missing_params", message: "Provide query params a and b (crawl job ids)." }, { status: 400 });
  }
  if (jobA === jobB) {
    return NextResponse.json(
      { error: "same_job", message: "Baseline job (a) and compare job (b) must be different." },
      { status: 400 },
    );
  }

  const [existsA, existsB] = await Promise.all([
    prisma.crawlJob.findUnique({ where: { id: jobA }, select: { id: true } }),
    prisma.crawlJob.findUnique({ where: { id: jobB }, select: { id: true } }),
  ]);
  if (!existsA || !existsB) {
    return NextResponse.json({ error: "not_found", message: "One or both crawl jobs were not found." }, { status: 404 });
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
  } as const;

  const [auditsA, auditsB] = await Promise.all([
    prisma.crawlPageAudit.findMany({ where: { jobId: jobA }, select }),
    prisma.crawlPageAudit.findMany({ where: { jobId: jobB }, select }),
  ]);

  const mapA = auditsToMap(auditsA as AuditRow[]);
  const mapB = auditsToMap(auditsB as AuditRow[]);

  type OutRow = Record<string, string | number | null>;
  const rows: OutRow[] = [];

  for (const [h, rb] of mapB) {
    if (!mapA.has(h)) {
      rows.push({
        change_kind: "new_in_b",
        changed_fields: "",
        url: rb.url,
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
      });
    }
  }

  for (const [h, ra] of mapA) {
    if (!mapB.has(h)) {
      rows.push({
        change_kind: "removed_in_a",
        changed_fields: "",
        url: ra.url,
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
      });
    }
  }

  for (const [h, ra] of mapA) {
    const rb = mapB.get(h);
    if (!rb) continue;
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
    if (
      !statusDiff &&
      !titleDiff &&
      !canDiff &&
      !metaDiff &&
      !wordDiff &&
      !h1TextDiff &&
      !h1CountDiff &&
      !contentTypeDiff &&
      !robotsDiff &&
      !metaRefreshDiff
    )
      continue;

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

    rows.push({
      change_kind: "changed",
      changed_fields: fields.join("|"),
      url: ra.url,
      depth_a: ra.depth,
      depth_b: rb.depth,
      http_status_a: ra.httpStatus ?? "",
      http_status_b: rb.httpStatus ?? "",
      title_a: normStr(ra.title),
      title_b: normStr(rb.title),
      canonical_a: normStr(ra.canonicalUrl),
      canonical_b: normStr(rb.canonicalUrl),
      meta_description_a: normStr(ra.metaDesc),
      meta_description_b: normStr(rb.metaDesc),
      word_count_a: ra.wordCount,
      word_count_b: rb.wordCount,
      h1_text_a: normStr(ra.h1Text),
      h1_text_b: normStr(rb.h1Text),
      h1_count_a: ra.h1Count,
      h1_count_b: rb.h1Count,
      content_type_a: normStr(ra.contentType),
      content_type_b: normStr(rb.contentType),
      robots_meta_a: normStr(ra.robotsMeta),
      robots_meta_b: normStr(rb.robotsMeta),
      meta_refresh_a: normStr(ra.metaRefreshContent),
      meta_refresh_b: normStr(rb.metaRefreshContent),
    });
  }

  rows.sort((x, y) => {
    const o = String(x.change_kind).localeCompare(String(y.change_kind));
    if (o !== 0) return o;
    return String(x.url).localeCompare(String(y.url));
  });

  if (format === "json") {
    return NextResponse.json({
      job_a: jobA,
      job_b: jobB,
      counts: {
        new_in_b: rows.filter((r) => r.change_kind === "new_in_b").length,
        removed_in_a: rows.filter((r) => r.change_kind === "removed_in_a").length,
        changed: rows.filter((r) => r.change_kind === "changed").length,
      },
      rows,
    });
  }

  const headers = [
    "change_kind",
    "changed_fields",
    "url",
    "depth_a",
    "depth_b",
    "http_status_a",
    "http_status_b",
    "title_a",
    "title_b",
    "canonical_a",
    "canonical_b",
    "meta_description_a",
    "meta_description_b",
    "word_count_a",
    "word_count_b",
    "h1_text_a",
    "h1_text_b",
    "h1_count_a",
    "h1_count_b",
    "content_type_a",
    "content_type_b",
    "robots_meta_a",
    "robots_meta_b",
    "meta_refresh_a",
    "meta_refresh_b",
  ] as const;

  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCsvCell(r[h])).join(","));
  }

  const body = lines.join("\n");
  const fname = `crawl-compare-${jobA.slice(0, 8)}-${jobB.slice(0, 8)}.csv`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fname}"`,
    },
  });
}
