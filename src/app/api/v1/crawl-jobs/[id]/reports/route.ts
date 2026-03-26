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
}) {
  const issues: string[] = [];
  if (row.fetchError) issues.push("fetch_error");
  if (row.httpStatus != null && row.httpStatus >= 400 && row.httpStatus < 500) issues.push("client_error");
  if (row.httpStatus != null && row.httpStatus >= 500) issues.push("server_error");
  if (row.httpStatus != null && row.httpStatus >= 300 && row.httpStatus < 400) issues.push("redirect");
  if (!row.title) issues.push("missing_title");
  if (row.title && row.title.length > 60) issues.push("title_too_long");
  if (!row.metaDesc) issues.push("missing_meta_description");
  if (row.metaDesc && row.metaDesc.length > 160) issues.push("meta_description_too_long");
  if (row.h1Count === 0) issues.push("missing_h1");
  if (!row.canonicalUrl) issues.push("missing_canonical");
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

export async function GET(req: Request, ctx: RouteCtx) {
  const { id: jobId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "excel" ? "excel" : "csv";
  const report = searchParams.get("report") ?? "issues";

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
      hreflang_count: a.hreflangCount,
      links_out_count: a.linksOutCount,
      word_count: a.wordCount,
      fetched_at: a.fetchedAt.toISOString(),
      fetch_error: a.fetchError,
    }));
  } else if (report === "duplicates") {
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
        rows.push({
          content_hash: hash,
          duplicate_group_size: list.length,
          url: row.url,
          depth: row.depth,
          title: row.title,
          word_count: row.wordCount,
          http_status: row.httpStatus,
        });
      }
    }
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
