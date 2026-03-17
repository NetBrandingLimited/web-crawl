import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;

  const job = await prisma.crawlJob.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      maxDepth: true,
      maxPages: true,
    },
  });

  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [queued, inProgress, done, skipped] = await Promise.all([
    prisma.crawlQueue.count({ where: { jobId: id, state: "pending" } }),
    prisma.crawlQueue.count({ where: { jobId: id, state: "in_progress" } }),
    prisma.crawlQueue.count({ where: { jobId: id, state: "done" } }),
    prisma.crawlQueue.count({ where: { jobId: id, state: "skipped" } }),
  ]);

  const failed = await prisma.urlFetch.count({ where: { jobId: id, status: "error" } });

  const fetched = done + skipped;

  return NextResponse.json({
    id: job.id,
    status: job.status,
    stats: {
      queued,
      in_progress: inProgress,
      fetched,
      succeeded: done,
      failed,
      disallowed: 0,
      from_sitemaps: 0,
      max_depth_reached: job.maxDepth,
    },
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    error: null,
  });
}

