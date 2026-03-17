import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;

  const updated = await prisma.crawlJob.update({
    where: { id },
    data: { status: "canceling" },
    select: { id: true, status: true },
  }).catch(() => null);

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ id: updated.id, status: updated.status }, { status: 202 });
}

