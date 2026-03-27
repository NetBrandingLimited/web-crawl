import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteCtx = { params: Promise<{ id: string }> };

function isSchemaDriftError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("crawlpageaudit") ||
    msg.includes("undefinedcolumn") ||
    msg.includes("unknown column") ||
    msg.includes("does not exist") ||
    msg.includes("the column") ||
    msg.includes("p2022") ||
    msg.includes("relation")
  );
}

function xmlEscape(v: string) {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id: jobId } = await ctx.params;

  let rows: Array<{
    url: string;
    depth: number;
    httpStatus: number | null;
    robotsMeta: string | null;
    xRobotsTag: string | null;
    fetchedAt: Date;
  }> = [];
  try {
    rows = await prisma.crawlPageAudit.findMany({
      where: { jobId },
      select: {
        url: true,
        depth: true,
        httpStatus: true,
        robotsMeta: true,
        xRobotsTag: true,
        fetchedAt: true,
      },
      orderBy: [{ depth: "asc" }, { url: "asc" }],
    });
  } catch (err) {
    if (!isSchemaDriftError(err)) throw err;
    const legacyRows = await prisma.crawlPageAudit.findMany({
      where: { jobId },
      select: {
        url: true,
        depth: true,
        httpStatus: true,
        robotsMeta: true,
        fetchedAt: true,
      },
      orderBy: [{ depth: "asc" }, { url: "asc" }],
    });
    rows = legacyRows.map((r) => ({ ...r, xRobotsTag: null }));
  }

  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: "no_audit_data",
        message: "No audit data yet for this job. Run worker or start a new crawl, then refresh.",
      },
      { status: 409 },
    );
  }

  const urls = rows.filter((r) => {
    const combined = `${r.robotsMeta ?? ""} ${r.xRobotsTag ?? ""}`.toLowerCase();
    const hasNoindex = combined.includes("noindex") || combined.includes("none");
    const okStatus = r.httpStatus == null || (r.httpStatus >= 200 && r.httpStatus < 300);
    return okStatus && !hasNoindex;
  });

  const xmlRows = urls.map((r) => ({ url: r.url, depth: r.depth, lastmod: r.fetchedAt }));

  const body = xmlRows
    .map((r) => {
      const priority = Math.max(0.1, 1 - r.depth * 0.1).toFixed(1);
      return [
        "  <url>",
        `    <loc>${xmlEscape(r.url)}</loc>`,
        `    <lastmod>${r.lastmod.toISOString().slice(0, 10)}</lastmod>`,
        "    <changefreq>weekly</changefreq>",
        `    <priority>${priority}</priority>`,
        "  </url>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    "</urlset>",
    "",
  ].join("\n");

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="sitemap-${jobId}.xml"`,
    },
  });
}
