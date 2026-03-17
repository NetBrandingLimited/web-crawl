import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeInputToUrl, sha1Hex } from "@/lib/crawl-url";

const createCrawlJobSchema = z
  .object({
    domain: z.string().trim().min(1).optional(),
    sitemaps: z.array(z.string().trim().min(1)).optional(),
    options: z
      .object({
        obey_robots: z.boolean().optional(),
        user_agent: z.string().trim().min(1).optional(),
        include_subdomains: z.boolean().optional(),
        same_site_only: z.boolean().optional(),
        max_depth: z.number().int().min(0).max(10).optional(),
        max_pages: z.number().int().min(1).max(100_000).optional(),
        max_duration_seconds: z.number().int().min(1).max(86_400).optional(),
        rate_limit_rps_per_host: z.number().min(0.1).max(10).optional(),
        max_concurrency_per_host: z.number().int().min(1).max(16).optional(),
        allowed_path_patterns: z.array(z.string()).optional(),
        blocked_path_patterns: z.array(z.string()).optional(),
        follow_redirects: z.boolean().optional(),
        respect_nofollow: z.boolean().optional(),
        strip_tracking: z.boolean().optional(),
        parse_content_types: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .refine((v) => v.domain || (v.sitemaps && v.sitemaps.length > 0), {
    message: "Provide either domain or sitemaps[]",
    path: ["domain"],
  });

export async function POST(req: Request) {
  const parsed = createCrawlJobSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { domain, sitemaps, options } = parsed.data;
  const seed = normalizeInputToUrl(domain ?? sitemaps![0]);

  const userAgent = options?.user_agent ?? "StreamingFrogBot/0.1";
  const obeyRobots = options?.obey_robots ?? true;

  const created = await prisma.domain.upsert({
    where: { hostname_scheme: { hostname: seed.hostname, scheme: seed.protocol.replace(":", "") } },
    create: {
      hostname: seed.hostname,
      scheme: seed.protocol.replace(":", ""),
      obeyRobots,
    },
    update: {
      obeyRobots,
    },
    select: { id: true },
  });

  const allowedPatterns =
    options?.allowed_path_patterns && options.allowed_path_patterns.length > 0
      ? options.allowed_path_patterns.join("\n")
      : null;
  const blockedPatterns =
    options?.blocked_path_patterns && options.blocked_path_patterns.length > 0
      ? options.blocked_path_patterns.join("\n")
      : null;

  const job = await prisma.crawlJob.create({
    data: {
      domainId: created.id,
      seedUrl: seed.toString(),
      status: "queued",
      userAgent,
      obeyRobots,
      includeSubdomains: options?.include_subdomains ?? false,
      sameSiteOnly: options?.same_site_only ?? true,
      maxDepth: options?.max_depth ?? 3,
      maxPages: options?.max_pages ?? 5000,
      maxDurationSeconds: options?.max_duration_seconds ?? 3600,
      rateLimitRpsPerHost: options?.rate_limit_rps_per_host ?? 2,
      maxConcurrencyPerHost: options?.max_concurrency_per_host ?? 2,
      followRedirects: options?.follow_redirects ?? true,
      respectNofollow: options?.respect_nofollow ?? true,
      stripTracking: options?.strip_tracking ?? true,
      allowedPathPatterns: allowedPatterns,
      blockedPathPatterns: blockedPatterns,
      parseContentTypes: options?.parse_content_types ? JSON.stringify(options.parse_content_types) : null,
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      seedUrl: true,
      maxDepth: true,
      maxPages: true,
      maxDurationSeconds: true,
      rateLimitRpsPerHost: true,
      maxConcurrencyPerHost: true,
      userAgent: true,
      obeyRobots: true,
      includeSubdomains: true,
      sameSiteOnly: true,
    },
  });

  // Seed the queue with the seed URL (actual crawler worker will expand later).
  await prisma.crawlQueue.create({
    data: {
      jobId: job.id,
      urlHash: sha1Hex(job.seedUrl),
      url: job.seedUrl,
      depth: 0,
      state: "pending",
      priority: 0,
      availableAt: new Date(),
    },
  });

  return NextResponse.json(
    {
      id: job.id,
      status: job.status,
      created_at: job.createdAt,
      options: {
        obey_robots: job.obeyRobots,
        user_agent: job.userAgent,
        include_subdomains: job.includeSubdomains,
        same_site_only: job.sameSiteOnly,
        max_depth: job.maxDepth,
        max_pages: job.maxPages,
        max_duration_seconds: job.maxDurationSeconds,
        rate_limit_rps_per_host: Number(job.rateLimitRpsPerHost),
        max_concurrency_per_host: job.maxConcurrencyPerHost,
      },
      seed_summary: {
        seed_url: job.seedUrl,
        domain: seed.hostname,
        sitemaps: sitemaps ?? [],
      },
    },
    { status: 201 },
  );
}

