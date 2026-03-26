"use client";

import { useMemo, useState } from "react";

const WORKER_STEPS_CAP = 4000;
const DEFAULT_MAX_DEPTH = 10;
// Keep this close to the "about 500 URLs" target so the crawl doesn't explode.
const DEFAULT_MAX_PAGES = 600;
const URLS_TABLE_LIMIT = 500;

type CrawlJobCreateResponse = {
  id: string;
  status: string;
  created_at: string;
};

type CrawlJobStatusResponse = {
  id: string;
  status: string;
  stats: {
    queued: number;
    in_progress: number;
    fetched: number;
    succeeded: number;
    failed: number;
    disallowed: number;
  };
};

type CrawlUrlsResponse = {
  items: Array<{
    id: string;
    original_url: string;
    crawl_depth: number;
    _queue_state: string;
    http_status: number | null;
    title: string | null;
  }>;
  next_cursor: string | null;
};

type CrawlSummaryResponse = {
  jobId: string;
  totals: {
    urls: number;
    broken: number;
    redirects: number;
    missingTitles: number;
    missingMetaDescriptions: number;
    missingH1: number;
    exactDuplicates: number;
    duplicateTitles: number;
    duplicateMetaDescriptions: number;
    nearDuplicates: number;
    canonicalIssues: number;
    headingIssues: number;
    orphanPages: number;
    urlIssues: number;
    directivesIssues: number;
    hreflangIssues: number;
    indexableUrls: number;
  };
};

export default function CrawlPage() {
  const [domain, setDomain] = useState("example.com");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<CrawlJobStatusResponse | null>(null);
  const [urls, setUrls] = useState<CrawlUrlsResponse["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [crawlSteps, setCrawlSteps] = useState(0);
  const [reportSummary, setReportSummary] = useState<CrawlSummaryResponse["totals"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (!status) return null;
    return [
      { label: "Status", value: status.status },
      { label: "Queued", value: status.stats.queued },
      { label: "In progress", value: status.stats.in_progress },
      { label: "Fetched", value: status.stats.fetched },
      { label: "Succeeded", value: status.stats.succeeded },
      { label: "Failed", value: status.stats.failed },
    ];
  }, [status]);

  async function drainWorkerForJob(id: string) {
    setCrawling(true);
    setCrawlSteps(0);
    setError(null);
    try {
      for (let step = 0; step < WORKER_STEPS_CAP; step++) {
        const res = await fetch(`/api/worker/crawl?jobId=${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({}))) as {
          message?: string;
          processed?: number;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(
            typeof json === "object" && json && "message" in json && typeof json.message === "string"
              ? json.message
              : `Worker HTTP ${res.status}`,
          );
        }
        if (json.message === "No pending URLs") break;
        const processed = Number(json.processed ?? 0);
        if (!Number.isFinite(processed) || processed <= 0) break;
        setCrawlSteps(step + 1);
        await refresh(id);
        await loadUrls(id);
      }
      await refresh(id);
      await loadUrls(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Crawl worker failed");
    } finally {
      setCrawling(false);
    }
  }

  async function start() {
    setLoading(true);
    setError(null);
    setUrls([]);
    setStatus(null);

    try {
      const res = await fetch("/api/v1/crawl-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domain,
          options: {
            max_depth: DEFAULT_MAX_DEPTH,
            max_pages: DEFAULT_MAX_PAGES,
            rate_limit_rps_per_host: 2,
          },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as CrawlJobCreateResponse;
      setJobId(json.id);
      await refresh(json.id);
      await loadUrls(json.id);
      await drainWorkerForJob(json.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start crawl");
    } finally {
      setLoading(false);
    }
  }

  async function runWorkerOnly() {
    if (!jobId) return;
    await drainWorkerForJob(jobId);
  }

  async function refresh(id?: string) {
    const effectiveId = id ?? jobId;
    if (!effectiveId) return;
    const res = await fetch(`/api/v1/crawl-jobs/${effectiveId}`, { cache: "no-store" });
    if (!res.ok) return;
    setStatus((await res.json()) as CrawlJobStatusResponse);
    const summaryRes = await fetch(`/api/v1/crawl-jobs/${effectiveId}/reports?report=summary`, {
      cache: "no-store",
    });
    if (summaryRes.ok) {
      const summaryJson = (await summaryRes.json()) as CrawlSummaryResponse;
      setReportSummary(summaryJson.totals);
    }
  }

  async function loadUrls(id?: string) {
    const effectiveId = id ?? jobId;
    if (!effectiveId) return;
    const res = await fetch(`/api/v1/crawl-jobs/${effectiveId}/urls?limit=${URLS_TABLE_LIMIT}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as CrawlUrlsResponse;
    setUrls(json.items);
  }

  function exportReport(
    report:
      | "issues"
      | "pages"
      | "duplicates"
      | "redirects"
      | "duplicate_titles"
      | "duplicate_meta_descriptions"
      | "near_duplicates"
      | "canonical_audit"
      | "heading_audit"
      | "site_structure"
      | "url_issues"
      | "directives_audit"
      | "hreflang_audit",
    format: "csv" | "excel",
  ) {
    if (!jobId) return;
    const u = `/api/v1/crawl-jobs/${jobId}/reports?report=${report}&format=${format}`;
    window.open(u, "_blank", "noopener,noreferrer");
  }

  function exportSitemapXml() {
    if (!jobId) return;
    const u = `/api/v1/crawl-jobs/${jobId}/sitemap`;
    window.open(u, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Crawler & URL Discovery</h1>
            <p className="mt-2 text-sm text-zinc-600">
              Starts a site crawl (same host, depth and page limits from the job), discovers internal links, and records HTTP status per URL.
              This is a lightweight crawler—not a full Screaming Frog replacement: advanced SEO checks (JS rendering, duplicate packs, custom
              extractions, sitemap builder) would be follow-on work on top of this pipeline.
            </p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            {jobId ? (
              <div>
                <div className="font-mono">job: {jobId}</div>
                <button
                  className="mt-2 rounded-md border border-zinc-200 bg-white px-3 py-1.5 hover:bg-zinc-50"
                  onClick={() => refresh()}
                  type="button"
                >
                  Refresh
                </button>
              </div>
            ) : (
              <div>No job yet</div>
            )}
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="text-sm font-medium">Start crawl</div>
            <label className="mt-4 block text-xs font-medium text-zinc-700">Domain or URL</label>
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900/10"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
            />
            <button
              className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-900 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              onClick={start}
              disabled={loading || crawling || domain.trim().length === 0}
              type="button"
            >
              {loading || crawling ? "Crawling…" : "Start crawl job"}
            </button>
            <button
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border border-zinc-300 bg-white text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => runWorkerOnly()}
              disabled={!jobId || loading || crawling}
              type="button"
            >
              Continue crawl (drain queue)
            </button>
            {crawling ? (
              <p className="mt-2 text-xs text-zinc-500">
                Calling the serverless worker in batches (leave this tab open). Batch {crawlSteps}…
              </p>
            ) : null}
            {error ? <div className="mt-3 text-sm text-red-600">{error}</div> : null}
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="text-sm font-medium">Status</div>
            {summary ? (
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                {summary.map((s) => (
                  <div key={s.label} className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2">
                    <div className="text-xs text-zinc-500">{s.label}</div>
                    <div className="mt-1 font-medium">{String(s.value)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 text-sm text-zinc-500">No status loaded.</div>
            )}
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
            <div className="text-sm font-medium">Phase 1 Reports</div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("issues", "csv")}
                disabled={!jobId}
                type="button"
              >
                Issues CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("pages", "csv")}
                disabled={!jobId}
                type="button"
              >
                Pages CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("duplicates", "csv")}
                disabled={!jobId}
                type="button"
              >
                Duplicates CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("redirects", "csv")}
                disabled={!jobId}
                type="button"
              >
                Redirects CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("duplicate_titles", "csv")}
                disabled={!jobId}
                type="button"
              >
                Duplicate Titles CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("duplicate_meta_descriptions", "csv")}
                disabled={!jobId}
                type="button"
              >
                Duplicate Meta CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("near_duplicates", "csv")}
                disabled={!jobId}
                type="button"
              >
                Near Duplicates CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("canonical_audit", "csv")}
                disabled={!jobId}
                type="button"
              >
                Canonical Audit CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("heading_audit", "csv")}
                disabled={!jobId}
                type="button"
              >
                H1/H2 Audit CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("site_structure", "csv")}
                disabled={!jobId}
                type="button"
              >
                Site Structure CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("url_issues", "csv")}
                disabled={!jobId}
                type="button"
              >
                URL Issues CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("directives_audit", "csv")}
                disabled={!jobId}
                type="button"
              >
                Directives CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportReport("hreflang_audit", "csv")}
                disabled={!jobId}
                type="button"
              >
                hreflang CSV
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => exportSitemapXml()}
                disabled={!jobId}
                type="button"
              >
                Sitemap XML
              </button>
            </div>
          </div>
          {reportSummary ? (
            <div className="grid grid-cols-2 gap-2 border-b border-zinc-100 px-6 py-3 text-xs text-zinc-600 md:grid-cols-4">
              <div>URLs: {reportSummary.urls}</div>
              <div>Broken: {reportSummary.broken}</div>
              <div>Redirects: {reportSummary.redirects}</div>
              <div>Missing title: {reportSummary.missingTitles}</div>
              <div>Missing meta desc: {reportSummary.missingMetaDescriptions}</div>
              <div>Missing H1: {reportSummary.missingH1}</div>
              <div>Exact duplicates: {reportSummary.exactDuplicates}</div>
              <div>Duplicate titles: {reportSummary.duplicateTitles}</div>
              <div>Duplicate meta desc: {reportSummary.duplicateMetaDescriptions}</div>
              <div>Near duplicates: {reportSummary.nearDuplicates}</div>
              <div>Canonical issues: {reportSummary.canonicalIssues}</div>
              <div>Heading issues: {reportSummary.headingIssues}</div>
              <div>Orphan-like pages: {reportSummary.orphanPages}</div>
              <div>URL issues: {reportSummary.urlIssues}</div>
              <div>Directive issues: {reportSummary.directivesIssues}</div>
              <div>hreflang issues: {reportSummary.hreflangIssues}</div>
              <div>Indexable URLs: {reportSummary.indexableUrls}</div>
            </div>
          ) : null}
        </div>

        <div className="mt-8 rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
            <div className="text-sm font-medium">Discovered URLs</div>
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => loadUrls()}
              disabled={!jobId}
              type="button"
            >
              Reload
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-6 py-3 font-medium">URL</th>
                  <th className="px-6 py-3 font-medium">Depth</th>
                  <th className="px-6 py-3 font-medium">HTTP</th>
                  <th className="px-6 py-3 font-medium">Title</th>
                  <th className="px-6 py-3 font-medium">Queue state</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {urls.length === 0 ? (
                  <tr>
                    <td className="px-6 py-6 text-zinc-500" colSpan={5}>
                      No URLs yet.
                    </td>
                  </tr>
                ) : (
                  urls.map((u) => (
                    <tr key={u.id}>
                      <td className="px-6 py-3 font-mono text-xs">{u.original_url}</td>
                      <td className="px-6 py-3">{u.crawl_depth}</td>
                      <td className="px-6 py-3">{u.http_status ?? "-"}</td>
                      <td className="px-6 py-3">{u.title ?? "-"}</td>
                      <td className="px-6 py-3">{u._queue_state}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}


