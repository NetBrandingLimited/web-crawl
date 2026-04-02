/**
 * Runtime smoke test for /api/v1/crawl-jobs/compare (+ row/rows helpers).
 * Requires DATABASE_URL, NEXT server on BASE_URL (default http://127.0.0.1:3000).
 *
 * Usage (from repo root):
 *   node --env-file=.env ./node_modules/tsx/dist/cli.mjs scripts/smoke-compare-e2e.ts
 */
import { prisma } from "@/lib/prisma";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";

async function pickJobPair(): Promise<{ a: string; b: string } | null> {
  const envA = process.env.COMPARE_SMOKE_JOB_A;
  const envB = process.env.COMPARE_SMOKE_JOB_B;
  if (envA && envB && envA !== envB) {
    return { a: envA, b: envB };
  }

  const jobs = await prisma.crawlJob.findMany({
    where: { audits: { some: {} } },
    select: { id: true, domainId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 80,
  });
  if (jobs.length < 2) return null;
  const byDomain = new Map<string, string[]>();
  for (const j of jobs) {
    const list = byDomain.get(j.domainId) ?? [];
    list.push(j.id);
    byDomain.set(j.domainId, list);
  }
  for (const ids of byDomain.values()) {
    if (ids.length >= 2) return { a: ids[0], b: ids[1] };
  }
  return { a: jobs[0].id, b: jobs[1].id };
}

type JsonPage = {
  total_diff_rows?: number;
  rows?: Array<{ url_hash: string }>;
  next_cursor?: string | null;
};

async function fetchJson(url: string): Promise<JsonPage> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} -> ${res.status} ${text.slice(0, 500)}`);
  }
  return (await res.json()) as JsonPage;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} -> ${res.status} ${text.slice(0, 500)}`);
  }
  return await res.text();
}

async function main() {
  const pair = await pickJobPair();
  if (!pair) {
    console.error("smoke-compare-e2e: need at least 2 crawl jobs with audits in DATABASE_URL.");
    process.exit(1);
  }
  const { a, b } = pair;
  console.log(`Using jobs a=${a} b=${b}`);

  const seen = new Set<string>();
  let cursor: string | null = null;
  let page = 0;
  let totalFromApi: number | null = null;
  const limit = 12;

  for (;;) {
    const q =
      `${BASE}/api/v1/crawl-jobs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` +
      `&format=json&paginate=1&limit=${limit}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await fetchJson(q);
    if (totalFromApi == null && typeof body.total_diff_rows === "number") {
      totalFromApi = body.total_diff_rows;
    }
    const rows = body.rows ?? [];
    page += 1;
    for (const r of rows) {
      if (seen.has(r.url_hash)) throw new Error(`duplicate url_hash in pages: ${r.url_hash}`);
      seen.add(r.url_hash);
    }
    const next = body.next_cursor ?? null;
    if (!next) break;
    cursor = next;
    if (page > 5000) throw new Error("pagination exceeded safety cap");
  }

  if (totalFromApi != null && seen.size !== totalFromApi) {
    throw new Error(`total_diff_rows=${totalFromApi} but collected ${seen.size} rows across pages`);
  }
  console.log(`Paginated JSON: ${page} page(s), ${seen.size} unique rows, total_diff_rows=${totalFromApi}`);

  const csv = await fetchText(
    `${BASE}/api/v1/crawl-jobs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&format=csv`,
  );
  const headerLine = csv.split(/\r?\n/, 1)[0] ?? "";
  if (!headerLine.includes("url_hash") || !headerLine.includes("changed_fields")) {
    throw new Error(`CSV header missing expected columns: ${headerLine.slice(0, 200)}`);
  }
  console.log(`CSV OK (first line length ${headerLine.length} chars)`);

  const sample = [...seen].slice(0, 3);
  if (sample.length) {
    const bulkRes = await fetch(`${BASE}/api/v1/crawl-jobs/compare/rows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a, b, url_hashes: sample }),
    });
    if (!bulkRes.ok) {
      const text = await bulkRes.text();
      throw new Error(`POST compare/rows -> ${bulkRes.status} ${text.slice(0, 500)}`);
    }
    const bulk = (await bulkRes.json()) as { rows?: Array<{ url_hash?: string; row?: Record<string, unknown> }> };
    const bulkRows = bulk.rows;
    if (!Array.isArray(bulkRows) || bulkRows.length !== sample.length) {
      throw new Error(`compare/rows expected ${sample.length} rows, got ${JSON.stringify(bulkRows)?.slice(0, 200)}`);
    }
    for (let i = 0; i < sample.length; i++) {
      if (bulkRows[i]?.url_hash !== sample[i]) {
        throw new Error(`compare/rows url_hash mismatch at ${i}: expected ${sample[i]}, got ${bulkRows[i]?.url_hash}`);
      }
      const row = bulkRows[i]?.row;
      if (!row || typeof row.change_kind !== "string") {
        throw new Error(`compare/rows missing row.change_kind for ${sample[i]}`);
      }
    }
    for (const h of sample) {
      const one = new URL(`${BASE}/api/v1/crawl-jobs/compare/row`);
      one.searchParams.set("a", a);
      one.searchParams.set("b", b);
      one.searchParams.set("url_hash", h);
      const oneBody = await fetchJson(one.toString());
      const row = (oneBody as { row?: Record<string, unknown> }).row;
      if (!row || typeof row.change_kind !== "string") {
        throw new Error(`compare/row missing row.change_kind for ${h}`);
      }
    }
    console.log(`compare/row + compare/rows OK for ${sample.length} sample url_hash values`);
  }

  console.log("smoke-compare-e2e: all checks passed");
}

main()
  .catch((e: unknown) => {
    console.error(e);
    const code =
      e && typeof e === "object" && "code" in e && typeof (e as { code?: unknown }).code === "string"
        ? (e as { code: string }).code
        : "";
    if (code === "P2021") {
      console.error(
        "\n(Database schema missing tables — run migrations against DATABASE_URL, e.g. `npx prisma migrate deploy`, then retry.)\n",
      );
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
