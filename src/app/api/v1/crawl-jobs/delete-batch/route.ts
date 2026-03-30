import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "Provide a JSON body with ids: an array of 1–200 crawl job UUIDs.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }
  const uniqueIds = [...new Set(parsed.data.ids)];
  const result = await prisma.crawlJob.deleteMany({ where: { id: { in: uniqueIds } } });
  return NextResponse.json({ deleted: result.count, requested: uniqueIds.length, ids: uniqueIds });
}
