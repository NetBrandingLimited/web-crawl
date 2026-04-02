import { Buffer } from "node:buffer";
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

function parseCompareJsonCursor(raw: string | null): number | null {
  if (raw == null || raw === "") return 0;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as { o?: unknown };
    const o = Number(parsed.o);
    if (!Number.isFinite(o) || o < 0 || o > 50_000_000) return null;
    return Math.floor(o);
  } catch {
    return null;
  }
}

function encodeCompareJsonCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobA = searchParams.get("a");
  const jobB = searchParams.get("b");
  const format = searchParams.get("format") === "json" ? "json" : "csv";
  const rawLimit = Number(searchParams.get("limit") ?? "500");
  const pageLimit = Math.min(2000, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 500));
  /** When absent, JSON returns the full diff in one response (e.g. downloads). Use `paginate=1` for paged previews. */
  const jsonPaginated = searchParams.get("paginate") === "1" || searchParams.has("cursor");

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
    contentHash: true,
    xRobotsTag: true,
    htmlLang: true,
    responseTimeMs: true,
  } as const;

  const [auditsA, auditsB] = await Promise.all([
    prisma.crawlPageAudit.findMany({ where: { jobId: jobA }, select }),
    prisma.crawlPageAudit.findMany({ where: { jobId: jobB }, select }),
  ]);

  const mapA = auditsToMap(auditsA as AuditRow[]);
  const mapB = auditsToMap(auditsB as AuditRow[]);

  // Performance: for paginated preview (Phase 2), build only lightweight rows.
  // Expanded details are fetched lazily per `url_hash`.
  if (format === "json" && jsonPaginated) {
    type PreviewRow = {
      url_hash: string;
      change_kind: "new_in_b" | "removed_in_a" | "changed";
      changed_fields: string;
      url: string;
      http_status_a: number | string;
      http_status_b: number | string;
      title_a: string;
      title_b: string;
    };

    function changedFieldsTokenList(ra: AuditRow, rb: AuditRow): string {
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

      return fields.join("|");
    }

    function rowHasAnyDiff(ra: AuditRow, rb: AuditRow): boolean {
      // Early-exit: once any difference is found, we can treat the row as changed.
      if (ra.httpStatus !== rb.httpStatus) return true;
      // For string fields: if raw values are already strictly equal, skip `trim()` work.
      if (ra.title !== rb.title && normStr(ra.title) !== normStr(rb.title)) return true;
      if (ra.canonicalUrl !== rb.canonicalUrl && normStr(ra.canonicalUrl) !== normStr(rb.canonicalUrl)) return true;
      if (ra.metaDesc !== rb.metaDesc && normStr(ra.metaDesc) !== normStr(rb.metaDesc)) return true;
      if (ra.wordCount !== rb.wordCount) return true;
      if (ra.h1Text !== rb.h1Text && normStr(ra.h1Text) !== normStr(rb.h1Text)) return true;
      if (ra.h1Count !== rb.h1Count) return true;
      if (ra.contentType !== rb.contentType && normStr(ra.contentType) !== normStr(rb.contentType)) return true;
      if (ra.robotsMeta !== rb.robotsMeta && normStr(ra.robotsMeta) !== normStr(rb.robotsMeta)) return true;
      if (ra.metaRefreshContent !== rb.metaRefreshContent && normStr(ra.metaRefreshContent) !== normStr(rb.metaRefreshContent)) return true;
      if (ra.contentHash !== rb.contentHash && normStr(ra.contentHash) !== normStr(rb.contentHash)) return true;
      if (ra.xRobotsTag !== rb.xRobotsTag && normStr(ra.xRobotsTag) !== normStr(rb.xRobotsTag)) return true;
      if (ra.htmlLang !== rb.htmlLang && normStr(ra.htmlLang) !== normStr(rb.htmlLang)) return true;
      if (ra.responseTimeMs !== rb.responseTimeMs) return true;
      return false;
    }

    // Performance: avoid building/sorting full `PreviewRow` objects for all diff candidates.
    // For pagination we only construct the rows that fall inside the current `[offset, offset+limit)` slice.
    type ChangedCand = {
      url_hash: string;
      url: string;
      http_status_a: number | string;
      http_status_b: number | string;
      i: number; // insertion order for stable tie-breaking
    };
    type NewInBCand = { url_hash: string; url: string; http_status_b: number | string; i: number };
    type RemovedInACand = { url_hash: string; url: string; http_status_a: number | string; i: number };

    const changedCands: ChangedCand[] = [];
    const newInBCands: NewInBCand[] = [];
    const removedInACands: RemovedInACand[] = [];

    for (const [h, rb] of mapB) {
      if (!mapA.has(h)) {
        newInBCands.push({
          url_hash: h,
          url: rb.url,
          http_status_b: rb.httpStatus ?? "",
          i: newInBCands.length,
        });
      }
    }

    for (const [h, ra] of mapA) {
      if (!mapB.has(h)) {
        removedInACands.push({
          url_hash: h,
          url: ra.url,
          http_status_a: ra.httpStatus ?? "",
          i: removedInACands.length,
        });
      }
    }

    for (const [h, ra] of mapA) {
      const rb = mapB.get(h);
      if (!rb) continue;
      if (!rowHasAnyDiff(ra, rb)) continue;

      changedCands.push({
        url_hash: h,
        url: ra.url,
        http_status_a: ra.httpStatus ?? "",
        http_status_b: rb.httpStatus ?? "",
        i: changedCands.length,
      });
    }

    const newInB = newInBCands.length;
    const removedInA = removedInACands.length;
    const changed = changedCands.length;
    const counts = {
      new_in_b: newInB,
      removed_in_a: removedInA,
      changed,
      pages_in_a: auditsA.length,
      pages_in_b: auditsB.length,
    };
    const totalDiffRows = changed + newInB + removedInA;

    const rawCursor = searchParams.get("cursor");
    let offset = 0;
    if (rawCursor) {
      const parsedOffset = parseCompareJsonCursor(rawCursor);
      if (parsedOffset === null) {
        return NextResponse.json(
          { error: "invalid_cursor", message: "Invalid cursor for compare pagination." },
          { status: 400 },
        );
      }
      offset = parsedOffset;
    }
    if (offset > totalDiffRows) {
      return NextResponse.json(
        { error: "cursor_out_of_range", message: "Cursor offset is beyond this compare result set." },
        { status: 400 },
      );
    }

    const urlThenIAsc = <T extends { url: string; i: number }>(a: T, b: T) => {
      if (a.url < b.url) return -1;
      if (a.url > b.url) return 1;
      // Tie-break by insertion order to reproduce stable `sort` behavior.
      return a.i - b.i;
    };

    function selectUrlSlice<T extends { url: string; i: number }>(items: T[], start: number, count: number): T[] {
      if (count <= 0) return [];
      const n = items.length;
      if (start >= n) return [];
      const endExclusive = Math.min(n, start + count);
      const heapSize = endExclusive; // keep smallest `heapSize` items

      // Max-heap by key: keeps the largest among the "smallest set".
      const heap: T[] = [];
      const isGreater = (a: T, b: T) => urlThenIAsc(a, b) > 0;

      const heapifyUp = (idx: number) => {
        while (idx > 0) {
          const parent = (idx - 1) >> 1;
          if (!isGreater(heap[idx], heap[parent])) break;
          const tmp = heap[parent];
          heap[parent] = heap[idx];
          heap[idx] = tmp;
          idx = parent;
        }
      };

      const heapifyDown = (idx: number) => {
        const len = heap.length;
        while (true) {
          const left = idx * 2 + 1;
          const right = left + 1;
          let largest = idx;
          if (left < len && isGreater(heap[left], heap[largest])) largest = left;
          if (right < len && isGreater(heap[right], heap[largest])) largest = right;
          if (largest === idx) break;
          const tmp = heap[largest];
          heap[largest] = heap[idx];
          heap[idx] = tmp;
          idx = largest;
        }
      };

      for (const item of items) {
        if (heap.length < heapSize) {
          heap.push(item);
          heapifyUp(heap.length - 1);
          continue;
        }
        // Keep only the smallest `heapSize` items.
        if (urlThenIAsc(item, heap[0]) < 0) {
          heap[0] = item;
          heapifyDown(0);
        }
      }

      heap.sort(urlThenIAsc);
      return heap.slice(start, endExclusive);
    }

    const endExclusiveGlobal = Math.min(totalDiffRows, offset + pageLimit);

    // Global ordering: [changed][new_in_b][removed_in_a]
    const changedStart = offset;
    const changedEnd = Math.min(changed, endExclusiveGlobal);
    const newStartGlobal = Math.max(changed, offset);
    const newEndGlobal = Math.min(changed + newInB, endExclusiveGlobal);
    const removedStartGlobal = Math.max(changed + newInB, offset);
    const removedEndGlobal = Math.min(totalDiffRows, endExclusiveGlobal);

    const changedSlice = changedStart < changedEnd ? selectUrlSlice(changedCands, changedStart, changedEnd - changedStart) : [];
    const newSlice =
      newStartGlobal < newEndGlobal ? selectUrlSlice(newInBCands, newStartGlobal - changed, newEndGlobal - newStartGlobal) : [];
    const removedSlice =
      removedStartGlobal < removedEndGlobal
        ? selectUrlSlice(removedInACands, removedStartGlobal - (changed + newInB), removedEndGlobal - removedStartGlobal)
        : [];

    const pageRows: PreviewRow[] = [];

    // Materialize returned rows in global order: changed -> new_in_b -> removed_in_a.
    for (const cand of changedSlice) {
      const ra = mapA.get(cand.url_hash);
      const rb = mapB.get(cand.url_hash);
      if (!ra || !rb) continue;
      pageRows.push({
        change_kind: "changed",
        changed_fields: changedFieldsTokenList(ra, rb),
        url_hash: cand.url_hash,
        url: cand.url,
        http_status_a: cand.http_status_a,
        http_status_b: cand.http_status_b,
        title_a: normStr(ra.title),
        title_b: normStr(rb.title),
      });
    }

    for (const cand of newSlice) {
      const rb = mapB.get(cand.url_hash);
      pageRows.push({
        change_kind: "new_in_b",
        changed_fields: "",
        url_hash: cand.url_hash,
        url: cand.url,
        http_status_a: "",
        http_status_b: cand.http_status_b,
        title_a: "",
        title_b: rb ? normStr(rb.title) : "",
      });
    }

    for (const cand of removedSlice) {
      const ra = mapA.get(cand.url_hash);
      pageRows.push({
        change_kind: "removed_in_a",
        changed_fields: "",
        url_hash: cand.url_hash,
        url: cand.url,
        http_status_a: cand.http_status_a,
        http_status_b: "",
        title_a: ra ? normStr(ra.title) : "",
        title_b: "",
      });
    }

    const nextOffset = offset + pageRows.length;
    const next_cursor = nextOffset < totalDiffRows ? encodeCompareJsonCursor(nextOffset) : null;

    return NextResponse.json({
      job_a: jobA,
      job_b: jobB,
      counts,
      total_diff_rows: totalDiffRows,
      limit: pageLimit,
      offset,
      rows: pageRows,
      next_cursor,
    });
  }

  type OutRow = Record<string, string | number | null>;
  const rows: OutRow[] = [];

  for (const [h, rb] of mapB) {
    if (!mapA.has(h)) {
      rows.push({
        change_kind: "new_in_b",
        changed_fields: "",
        url_hash: h,
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
        content_hash_a: "",
        content_hash_b: normStr(rb.contentHash),
        x_robots_tag_a: "",
        x_robots_tag_b: normStr(rb.xRobotsTag),
        html_lang_a: "",
        html_lang_b: normStr(rb.htmlLang),
        response_time_ms_a: "",
        response_time_ms_b: rb.responseTimeMs ?? "",
      });
    }
  }

  for (const [h, ra] of mapA) {
    if (!mapB.has(h)) {
      rows.push({
        change_kind: "removed_in_a",
        changed_fields: "",
        url_hash: h,
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
        content_hash_a: normStr(ra.contentHash),
        content_hash_b: "",
        x_robots_tag_a: normStr(ra.xRobotsTag),
        x_robots_tag_b: "",
        html_lang_a: normStr(ra.htmlLang),
        html_lang_b: "",
        response_time_ms_a: ra.responseTimeMs ?? "",
        response_time_ms_b: "",
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
    const contentHashDiff = normStr(ra.contentHash) !== normStr(rb.contentHash);
    const xRobotsDiff = normStr(ra.xRobotsTag) !== normStr(rb.xRobotsTag);
    const htmlLangDiff = normStr(ra.htmlLang) !== normStr(rb.htmlLang);
    const responseTimeDiff = ra.responseTimeMs !== rb.responseTimeMs;
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
      !metaRefreshDiff &&
      !contentHashDiff &&
      !xRobotsDiff &&
      !htmlLangDiff &&
      !responseTimeDiff
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
    if (contentHashDiff) fields.push("content_hash");
    if (xRobotsDiff) fields.push("x_robots_tag");
    if (htmlLangDiff) fields.push("html_lang");
    if (responseTimeDiff) fields.push("response_time_ms");

    rows.push({
      change_kind: "changed",
      changed_fields: fields.join("|"),
      url_hash: h,
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
      content_hash_a: normStr(ra.contentHash),
      content_hash_b: normStr(rb.contentHash),
      x_robots_tag_a: normStr(ra.xRobotsTag),
      x_robots_tag_b: normStr(rb.xRobotsTag),
      html_lang_a: normStr(ra.htmlLang),
      html_lang_b: normStr(rb.htmlLang),
      response_time_ms_a: ra.responseTimeMs ?? "",
      response_time_ms_b: rb.responseTimeMs ?? "",
    });
  }

  rows.sort((x, y) => {
    const o = String(x.change_kind).localeCompare(String(y.change_kind));
    if (o !== 0) return o;
    return String(x.url).localeCompare(String(y.url));
  });

  if (format === "json") {
    let newInB = 0;
    let removedInA = 0;
    let changed = 0;
    for (const r of rows) {
      const k = r.change_kind;
      if (k === "new_in_b") newInB += 1;
      else if (k === "removed_in_a") removedInA += 1;
      else if (k === "changed") changed += 1;
    }
    const counts = {
      new_in_b: newInB,
      removed_in_a: removedInA,
      changed,
      pages_in_a: auditsA.length,
      pages_in_b: auditsB.length,
    };
    const totalDiffRows = rows.length;

    if (!jsonPaginated) {
      return NextResponse.json({
        job_a: jobA,
        job_b: jobB,
        counts,
        total_diff_rows: totalDiffRows,
        rows,
        next_cursor: null,
      });
    }

    // `jsonPaginated` is already handled by the early lightweight preview block above.
    // This branch should never execute.
    return NextResponse.json(
      { error: "unexpected_json_paginated", message: "Internal error: compare pagination path skipped early return." },
      { status: 500 },
    );
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
    "content_hash_a",
    "content_hash_b",
    "x_robots_tag_a",
    "x_robots_tag_b",
    "html_lang_a",
    "html_lang_b",
    "response_time_ms_a",
    "response_time_ms_b",
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
