import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const { id: jobId } = await ctx.params;
  const { searchParams } = new URL(req.url);

  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 1000);
  const cursor = searchParams.get("cursor");

  const rows = await prisma.crawlQueue.findMany({
    where: { jobId },
    orderBy: [{ enqueueAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      url: true,
      urlHash: true,
      depth: true,
      state: true,
      enqueueAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const nextCursor = hasMore ? items[items.length - 1]?.id : null;
  type QueueRow = (typeof items)[number];

  let audits: Array<{
    urlHash: string;
    httpStatus: number | null;
    contentType: string | null;
    title: string | null;
    canonicalUrl: string | null;
    linksOutCount: number;
    fetchError: string | null;
  }> = [];
  try {
    audits = await prisma.crawlPageAudit.findMany({
      where: { jobId, urlHash: { in: items.map((i) => i.urlHash) } },
      select: {
        urlHash: true,
        httpStatus: true,
        contentType: true,
        title: true,
        canonicalUrl: true,
        linksOutCount: true,
        fetchError: true,
      },
    });
  } catch (err) {
    if (!String(err).includes("CrawlPageAudit")) throw err;
  }
  const auditsByHash = new Map(audits.map((a) => [a.urlHash, a]));

  return NextResponse.json({
    items: items.map((r: QueueRow) => ({
      id: r.id,
      job_id: jobId,
      original_url: r.url,
      normalized_url: r.url,
      discovered_from: [],
      crawl_depth: r.depth,
      http_status: auditsByHash.get(r.urlHash)?.httpStatus ?? null,
      content_type: auditsByHash.get(r.urlHash)?.contentType ?? null,
      content_length: null,
      redirect_chain: [],
      final_url: null,
      canonical_url: auditsByHash.get(r.urlHash)?.canonicalUrl ?? null,
      canonical_source: null,
      from_sitemap: false,
      robots_applied: true,
      disallowed: r.state === "skipped",
      error_code: null,
      error_message: auditsByHash.get(r.urlHash)?.fetchError ?? null,
      fetch_started_at: null,
      fetch_finished_at: null,
      links_out_count: auditsByHash.get(r.urlHash)?.linksOutCount ?? null,
      title: auditsByHash.get(r.urlHash)?.title ?? null,
      _queue_state: r.state,
      _url_hash: r.urlHash,
      _enqueued_at: r.enqueueAt,
    })),
    next_cursor: nextCursor,
  });
} 

