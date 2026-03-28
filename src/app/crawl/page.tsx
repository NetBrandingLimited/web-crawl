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
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
    statusOther: number;
    statusUnknown: number;
    missingTitles: number;
    missingMetaDescriptions: number;
    missingH1: number;
    exactDuplicates: number;
    duplicateTitles: number;
    duplicateMetaDescriptions: number;
    duplicateH1: number;
    nearDuplicates: number;
    canonicalIssues: number;
    headingIssues: number;
    orphanPages: number;
    pagesWithZeroInlinks: number;
    avgInternalInlinks: number;
    pagesWithHighInlinks: number;
    maxCrawlDepth: number;
    avgCrawlDepth: number;
    deepPages: number;
    urlIssues: number;
    parameterizedUrls: number;
    parameterVariantGroups: number;
    parameterVariantUrls: number;
    directivesIssues: number;
    hreflangIssues: number;
    indexableUrls: number;
    indexableStrict: number;
    nonIndexable: number;
    nonIndexableByStatus: number;
    nonIndexableByNoindex: number;
    nonIndexableByCanonicalElsewhere: number;
    securityIssues: number;
    contentQualityIssues: number;
    brokenLinksWithSources: number;
    redirectChainIssues: number;
    pagesWithMissingImageAlt: number;
    totalImagesMissingAlt: number;
    pagesWithJsonLd: number;
    robotsTxtBlocked: number;
    avgResponseTimeMs: number;
    responseLt500ms: number;
    response500To1000ms: number;
    response1To3s: number;
    response3To5s: number;
    responseGt5s: number;
    slowResponsePages: number;
    pagesWithExternalLinks: number;
    pagesMissingOgTitle: number;
    pagesWithOgImage: number;
    pagesMissingTwitterCard: number;
    pagesMissingHtmlLang: number;
    pagesMissingViewport: number;
    pagesWithNofollowLinks: number;
    pagesWithRelNext: number;
    pagesWithRelPrev: number;
    pagesWithMailtoLinks: number;
    pagesWithTelLinks: number;
    totalMailtoLinks: number;
    totalTelLinks: number;
    totalHashOnlyLinks: number;
    pagesWithMetaRefresh: number;
    pagesWithTitleH1Mismatch: number;
    pagesCompressed: number;
    html2xxUncompressed: number;
    pagesWithContentLanguage: number;
    pagesMissingFavicon: number;
    https2xxMissingCacheControl: number;
    canonicalCrossDomain: number;
    canonicalProtocolMismatch: number;
    canonicalWithFragment: number;
    canonicalizedToOther: number;
    canonicalClusterCount: number;
    canonicalClusteredPages: number;
    canonicalLoopCount: number;
    canonicalLoopedPages: number;
    canonicalOrphanTargets: number;
    pagesWithAmphtml: number;
    pagesWithRssFeed: number;
    pagesWithAtomFeed: number;
    pagesWithJsonFeed: number;
    httpsMissingHsts: number;
    httpsMissingXContentTypeOptions: number;
    httpsMissingXFrameOptions: number;
    httpsMissingCsp: number;
  };
};

type ExportReportKey =
  | "issues"
  | "pages"
  | "duplicates"
  | "redirects"
  | "duplicate_titles"
  | "duplicate_h1"
  | "duplicate_meta_descriptions"
  | "near_duplicates"
  | "canonical_audit"
  | "canonical_status_conflicts"
  | "canonical_clusters"
  | "canonical_loops"
  | "canonical_orphans"
  | "heading_audit"
  | "site_structure"
  | "internal_link_graph"
  | "top_inlinked_pages"
  | "click_depth_distribution"
  | "crawl_pathing"
  | "top_directories"
  | "url_extensions"
  | "http_status_distribution"
  | "response_time_buckets"
  | "url_issues"
  | "parameter_variants"
  | "parameter_inventory"
  | "longest_urls"
  | "long_titles"
  | "short_titles"
  | "low_word_count"
  | "orphan_candidates_strict"
  | "missing_meta_descriptions"
  | "short_meta_descriptions"
  | "long_meta_descriptions"
  | "canonical_with_fragment"
  | "canonical_cross_domain"
  | "missing_canonical"
  | "canonical_protocol_mismatch"
  | "missing_h1"
  | "multiple_h1"
  | "insecure_http_urls"
  | "missing_titles"
  | "missing_html_lang"
  | "missing_viewport_meta"
  | "images_missing_alt"
  | "title_h1_mismatch"
  | "meta_refresh_present"
  | "slow_html_responses"
  | "uncompressed_html"
  | "missing_charset_meta"
  | "noindex_urls"
  | "missing_h2"
  | "missing_favicon"
  | "missing_hreflang"
  | "missing_json_ld"
  | "pagination_rel_incomplete"
  | "missing_og_title"
  | "missing_og_description"
  | "missing_og_image"
  | "missing_twitter_card"
  | "missing_twitter_title"
  | "missing_content_language"
  | "hash_only_internal_links"
  | "nofollow_directive_urls"
  | "non_robots_fetch_errors"
  | "missing_cache_control"
  | "sensitive_query_params"
  | "insecure_canonical_urls"
  | "redirect_response_urls"
  | "client_error_urls"
  | "server_error_urls"
  | "missing_hsts_https"
  | "missing_csp_https"
  | "missing_x_content_type_options_https"
  | "missing_x_frame_options_https"
  | "missing_referrer_policy_https"
  | "missing_permissions_policy_https"
  | "missing_etag_html"
  | "missing_last_modified_html"
  | "missing_vary_html"
  | "slow_html_2s_to_5s"
  | "html_non_2xx_responses"
  | "html_amphtml_link_present"
  | "html_feed_link_present"
  | "json_ld_missing_types_summary"
  | "high_external_link_ratio"
  | "html_zero_outlinks"
  | "high_nofollow_link_ratio"
  | "very_high_word_count_html"
  | "slow_html_1s_to_2s"
  | "many_h2_headings"
  | "indexability_audit"
  | "directives_audit"
  | "robots_blocked"
  | "hreflang_audit"
  | "security_audit"
  | "caching"
  | "encoding_audit"
  | "security_headers"
  | "content_quality"
  | "performance"
  | "link_breakdown"
  | "pagination"
  | "feeds_amp"
  | "social_meta"
  | "structured_data"
  | "images"
  | "broken_links"
  | "redirect_chains"
  | "redirect_canonical_mismatch";

const REPORT_BUTTONS: Array<{ id: ExportReportKey; label: string }> = [
  { id: "issues", label: "Issues CSV" },
  { id: "pages", label: "Pages CSV" },
  { id: "duplicates", label: "Duplicates CSV" },
  { id: "redirects", label: "Redirects CSV" },
  { id: "duplicate_titles", label: "Duplicate Titles CSV" },
  { id: "duplicate_h1", label: "Duplicate H1 CSV" },
  { id: "duplicate_meta_descriptions", label: "Duplicate Meta CSV" },
  { id: "near_duplicates", label: "Near Duplicates CSV" },
  { id: "canonical_audit", label: "Canonical Audit CSV" },
  { id: "canonical_status_conflicts", label: "Canonical Status Conflicts CSV" },
  { id: "canonical_clusters", label: "Canonical Clusters CSV" },
  { id: "canonical_loops", label: "Canonical Loops CSV" },
  { id: "canonical_orphans", label: "Canonical Orphans CSV" },
  { id: "heading_audit", label: "H1/H2 Audit CSV" },
  { id: "site_structure", label: "Site Structure CSV" },
  { id: "internal_link_graph", label: "Internal Link Graph CSV" },
  { id: "top_inlinked_pages", label: "Top Inlinked Pages CSV" },
  { id: "click_depth_distribution", label: "Click Depth Distribution CSV" },
  { id: "crawl_pathing", label: "Crawl Pathing CSV" },
  { id: "top_directories", label: "Top Directories CSV" },
  { id: "url_extensions", label: "URL Extensions CSV" },
  { id: "http_status_distribution", label: "HTTP Status Distribution CSV" },
  { id: "response_time_buckets", label: "Response Time Buckets CSV" },
  { id: "url_issues", label: "URL Issues CSV" },
  { id: "parameter_variants", label: "Parameter Variants CSV" },
  { id: "parameter_inventory", label: "Parameter Inventory CSV" },
  { id: "longest_urls", label: "Longest URLs CSV" },
  { id: "long_titles", label: "Long Titles CSV" },
  { id: "short_titles", label: "Short Titles CSV" },
  { id: "low_word_count", label: "Low Word Count CSV" },
  { id: "orphan_candidates_strict", label: "Orphan Candidates (Strict) CSV" },
  { id: "missing_meta_descriptions", label: "Missing Meta Descriptions CSV" },
  { id: "short_meta_descriptions", label: "Short Meta Descriptions CSV" },
  { id: "long_meta_descriptions", label: "Long Meta Descriptions CSV" },
  { id: "canonical_with_fragment", label: "Canonical With Fragment CSV" },
  { id: "canonical_cross_domain", label: "Canonical Cross-Domain CSV" },
  { id: "missing_canonical", label: "Missing Canonical CSV" },
  { id: "canonical_protocol_mismatch", label: "Canonical Protocol Mismatch CSV" },
  { id: "missing_h1", label: "Missing H1 CSV" },
  { id: "multiple_h1", label: "Multiple H1 CSV" },
  { id: "insecure_http_urls", label: "Insecure HTTP URLs CSV" },
  { id: "missing_titles", label: "Missing Titles CSV" },
  { id: "missing_html_lang", label: "Missing HTML Lang CSV" },
  { id: "missing_viewport_meta", label: "Missing Viewport Meta CSV" },
  { id: "images_missing_alt", label: "Images Missing Alt CSV" },
  { id: "title_h1_mismatch", label: "Title / H1 Mismatch CSV" },
  { id: "meta_refresh_present", label: "Meta Refresh Present CSV" },
  { id: "slow_html_responses", label: "Slow HTML Responses (5s+) CSV" },
  { id: "uncompressed_html", label: "Uncompressed HTML CSV" },
  { id: "missing_charset_meta", label: "Missing Charset Meta CSV" },
  { id: "noindex_urls", label: "Noindex URLs CSV" },
  { id: "missing_h2", label: "Missing H2 CSV" },
  { id: "missing_favicon", label: "Missing Favicon CSV" },
  { id: "missing_hreflang", label: "Missing hreflang CSV" },
  { id: "missing_json_ld", label: "Missing JSON-LD CSV" },
  { id: "pagination_rel_incomplete", label: "Pagination rel Incomplete CSV" },
  { id: "missing_og_title", label: "Missing OG Title CSV" },
  { id: "missing_og_description", label: "Missing OG Description CSV" },
  { id: "missing_og_image", label: "Missing OG Image CSV" },
  { id: "missing_twitter_card", label: "Missing Twitter Card CSV" },
  { id: "missing_twitter_title", label: "Missing Twitter Title CSV" },
  { id: "missing_content_language", label: "Missing Content-Language CSV" },
  { id: "hash_only_internal_links", label: "Hash-Only Internal Links CSV" },
  { id: "nofollow_directive_urls", label: "Nofollow Directive URLs CSV" },
  { id: "non_robots_fetch_errors", label: "Fetch Errors (non-robots) CSV" },
  { id: "missing_cache_control", label: "Missing Cache-Control CSV" },
  { id: "sensitive_query_params", label: "Sensitive Query Params CSV" },
  { id: "insecure_canonical_urls", label: "Insecure Canonical URLs CSV" },
  { id: "redirect_response_urls", label: "3xx Response URLs CSV" },
  { id: "client_error_urls", label: "4xx Response URLs CSV" },
  { id: "server_error_urls", label: "5xx Response URLs CSV" },
  { id: "missing_hsts_https", label: "HTTPS Missing HSTS CSV" },
  { id: "missing_csp_https", label: "HTTPS Missing CSP CSV" },
  { id: "missing_x_content_type_options_https", label: "HTTPS Missing X-Content-Type-Options CSV" },
  { id: "missing_x_frame_options_https", label: "HTTPS Missing X-Frame-Options CSV" },
  { id: "missing_referrer_policy_https", label: "HTTPS Missing Referrer-Policy CSV" },
  { id: "missing_permissions_policy_https", label: "HTTPS Missing Permissions-Policy CSV" },
  { id: "missing_etag_html", label: "Missing ETag (HTML) CSV" },
  { id: "missing_last_modified_html", label: "Missing Last-Modified (HTML) CSV" },
  { id: "missing_vary_html", label: "Missing Vary (HTML) CSV" },
  { id: "slow_html_2s_to_5s", label: "Slow HTML 2s-5s CSV" },
  { id: "html_non_2xx_responses", label: "HTML Non-2xx Responses CSV" },
  { id: "html_amphtml_link_present", label: "HTML With AMP Link CSV" },
  { id: "html_feed_link_present", label: "HTML With Feed Link CSV" },
  { id: "json_ld_missing_types_summary", label: "JSON-LD Missing Types Summary CSV" },
  { id: "high_external_link_ratio", label: "High External Link Ratio CSV" },
  { id: "html_zero_outlinks", label: "HTML Zero Outlinks CSV" },
  { id: "high_nofollow_link_ratio", label: "High Nofollow Link Ratio CSV" },
  { id: "very_high_word_count_html", label: "Very High Word Count (HTML) CSV" },
  { id: "slow_html_1s_to_2s", label: "Slow HTML 1s-2s CSV" },
  { id: "many_h2_headings", label: "Many H2 Headings (12+) CSV" },
  { id: "indexability_audit", label: "Indexability Audit CSV" },
  { id: "directives_audit", label: "Directives CSV" },
  { id: "robots_blocked", label: "Robots blocked CSV" },
  { id: "structured_data", label: "Structured Data CSV" },
  { id: "hreflang_audit", label: "hreflang CSV" },
  { id: "security_audit", label: "Security CSV" },
  { id: "caching", label: "Caching CSV" },
  { id: "encoding_audit", label: "Encoding CSV" },
  { id: "security_headers", label: "Security headers CSV" },
  { id: "content_quality", label: "Content Quality CSV" },
  { id: "performance", label: "Performance CSV" },
  { id: "link_breakdown", label: "Link breakdown CSV" },
  { id: "pagination", label: "Pagination CSV" },
  { id: "feeds_amp", label: "Feeds / AMP CSV" },
  { id: "social_meta", label: "Social / OG CSV" },
  { id: "images", label: "Images CSV" },
  { id: "broken_links", label: "Broken Links CSV" },
  { id: "redirect_chains", label: "Redirect Chains CSV" },
  { id: "redirect_canonical_mismatch", label: "Redirect vs Canonical CSV" },
];

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
      { label: "Robots.txt blocked", value: status.stats.disallowed },
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
    setError(null);
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
    await loadUrls(effectiveId);
  }

  async function loadUrls(id?: string) {
    const effectiveId = id ?? jobId;
    if (!effectiveId) return;
    const res = await fetch(`/api/v1/crawl-jobs/${effectiveId}/urls?limit=${URLS_TABLE_LIMIT}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as CrawlUrlsResponse;
    setUrls(json.items);
  }

  function triggerDownload(url: string) {
    // More reliable than window.open for attachment responses; avoids popup blocking.
    const a = document.createElement("a");
    a.href = url;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function exportReport(report: ExportReportKey, format: "csv" | "excel") {
    if (!jobId) return;
    const discovered = urls.length;
    if (discovered === 0) {
      setError("No crawl URLs found for this job yet. Start/continue crawl, then refresh.");
      return;
    }
    const u = `/api/v1/crawl-jobs/${jobId}/reports?report=${report}&format=${format}`;
    triggerDownload(u);
  }

  function exportSitemapXml() {
    if (!jobId) return;
    const discovered = urls.length;
    if (discovered === 0) {
      setError("No crawl URLs found for this job yet. Start/continue crawl, then refresh.");
      return;
    }
    const u = `/api/v1/crawl-jobs/${jobId}/sitemap`;
    triggerDownload(u);
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="w-full px-4 py-8 sm:px-6 lg:px-10 xl:px-12">
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
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {REPORT_BUTTONS.map((report) => (
                <button
                  key={report.id}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => exportReport(report.id, "csv")}
                  disabled={!jobId}
                  type="button"
                >
                  {report.label}
                </button>
              ))}
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
              <div>Status 2xx: {reportSummary.status2xx}</div>
              <div>Status 3xx: {reportSummary.status3xx}</div>
              <div>Status 4xx: {reportSummary.status4xx}</div>
              <div>Status 5xx: {reportSummary.status5xx}</div>
              <div>Status other: {reportSummary.statusOther}</div>
              <div>Status unknown: {reportSummary.statusUnknown}</div>
              <div>Missing title: {reportSummary.missingTitles}</div>
              <div>Missing meta desc: {reportSummary.missingMetaDescriptions}</div>
              <div>Missing H1: {reportSummary.missingH1}</div>
              <div>Exact duplicates: {reportSummary.exactDuplicates}</div>
              <div>Duplicate titles: {reportSummary.duplicateTitles}</div>
              <div>Duplicate H1: {reportSummary.duplicateH1}</div>
              <div>Duplicate meta desc: {reportSummary.duplicateMetaDescriptions}</div>
              <div>Near duplicates: {reportSummary.nearDuplicates}</div>
              <div>Canonical issues: {reportSummary.canonicalIssues}</div>
              <div>Heading issues: {reportSummary.headingIssues}</div>
              <div>Orphan-like pages: {reportSummary.orphanPages}</div>
              <div>Pages with zero inlinks: {reportSummary.pagesWithZeroInlinks}</div>
              <div>Avg internal inlinks: {reportSummary.avgInternalInlinks}</div>
              <div>Pages with high inlinks (≥5): {reportSummary.pagesWithHighInlinks}</div>
              <div>Max crawl depth: {reportSummary.maxCrawlDepth}</div>
              <div>Avg crawl depth: {reportSummary.avgCrawlDepth}</div>
              <div>Deep pages (depth ≥3): {reportSummary.deepPages}</div>
              <div>URL issues: {reportSummary.urlIssues}</div>
              <div>Parameterized URLs: {reportSummary.parameterizedUrls}</div>
              <div>Parameter variant groups: {reportSummary.parameterVariantGroups}</div>
              <div>URLs in parameter groups: {reportSummary.parameterVariantUrls}</div>
              <div>Directive issues: {reportSummary.directivesIssues}</div>
              <div>hreflang issues: {reportSummary.hreflangIssues}</div>
              <div>Indexable URLs: {reportSummary.indexableUrls}</div>
              <div>Strict indexable: {reportSummary.indexableStrict}</div>
              <div>Non-indexable: {reportSummary.nonIndexable}</div>
              <div>Non-indexable by status: {reportSummary.nonIndexableByStatus}</div>
              <div>Non-indexable by noindex: {reportSummary.nonIndexableByNoindex}</div>
              <div>
                Non-indexable by canonical elsewhere: {reportSummary.nonIndexableByCanonicalElsewhere}
              </div>
              <div>Security issues: {reportSummary.securityIssues}</div>
              <div>Content issues: {reportSummary.contentQualityIssues}</div>
              <div>Broken links w/source: {reportSummary.brokenLinksWithSources}</div>
              <div>Redirect chain issues: {reportSummary.redirectChainIssues}</div>
              <div>Pages w/ missing img alt: {reportSummary.pagesWithMissingImageAlt}</div>
              <div>Total images missing alt: {reportSummary.totalImagesMissingAlt}</div>
              <div>Pages with JSON-LD: {reportSummary.pagesWithJsonLd}</div>
              <div>Robots.txt blocked: {reportSummary.robotsTxtBlocked}</div>
              <div>Avg response (ms): {reportSummary.avgResponseTimeMs}</div>
              <div>Response &lt;500ms: {reportSummary.responseLt500ms}</div>
              <div>Response 500ms-1s: {reportSummary.response500To1000ms}</div>
              <div>Response 1s-3s: {reportSummary.response1To3s}</div>
              <div>Response 3s-5s: {reportSummary.response3To5s}</div>
              <div>Response &gt;5s: {reportSummary.responseGt5s}</div>
              <div>Slow pages (≥3s): {reportSummary.slowResponsePages}</div>
              <div>Pages w/ external links: {reportSummary.pagesWithExternalLinks}</div>
              <div>HTML 2xx missing og:title: {reportSummary.pagesMissingOgTitle}</div>
              <div>HTML 2xx with og:image: {reportSummary.pagesWithOgImage}</div>
              <div>HTML 2xx missing twitter:card: {reportSummary.pagesMissingTwitterCard}</div>
              <div>HTML 2xx missing lang: {reportSummary.pagesMissingHtmlLang}</div>
              <div>HTML 2xx missing viewport: {reportSummary.pagesMissingViewport}</div>
              <div>Pages w/ nofollow links: {reportSummary.pagesWithNofollowLinks}</div>
              <div>Pages w/ rel=next: {reportSummary.pagesWithRelNext}</div>
              <div>Pages w/ rel=prev: {reportSummary.pagesWithRelPrev}</div>
              <div>Pages w/ mailto: {reportSummary.pagesWithMailtoLinks}</div>
              <div>Pages w/ tel: {reportSummary.pagesWithTelLinks}</div>
              <div>Total mailto links: {reportSummary.totalMailtoLinks}</div>
              <div>Total tel links: {reportSummary.totalTelLinks}</div>
              <div>Total hash-only links: {reportSummary.totalHashOnlyLinks}</div>
              <div>HTML 2xx w/ meta refresh: {reportSummary.pagesWithMetaRefresh}</div>
              <div>HTML 2xx title≠H1: {reportSummary.pagesWithTitleH1Mismatch}</div>
              <div>Pages with compression: {reportSummary.pagesCompressed}</div>
              <div>HTML 2xx uncompressed: {reportSummary.html2xxUncompressed}</div>
              <div>Pages with content-language: {reportSummary.pagesWithContentLanguage}</div>
              <div>HTML 2xx missing favicon: {reportSummary.pagesMissingFavicon}</div>
              <div>HTTPS 2xx missing Cache-Control: {reportSummary.https2xxMissingCacheControl}</div>
              <div>Canonical cross-domain: {reportSummary.canonicalCrossDomain}</div>
              <div>Canonical protocol mismatch: {reportSummary.canonicalProtocolMismatch}</div>
              <div>Canonical with fragment: {reportSummary.canonicalWithFragment}</div>
              <div>Canonicalized to other: {reportSummary.canonicalizedToOther}</div>
              <div>Canonical clusters: {reportSummary.canonicalClusterCount}</div>
              <div>Pages in canonical clusters: {reportSummary.canonicalClusteredPages}</div>
              <div>Canonical loops: {reportSummary.canonicalLoopCount}</div>
              <div>Pages in canonical loops: {reportSummary.canonicalLoopedPages}</div>
              <div>Canonical orphan targets: {reportSummary.canonicalOrphanTargets}</div>
              <div>Pages with amphtml: {reportSummary.pagesWithAmphtml}</div>
              <div>Pages with RSS feed: {reportSummary.pagesWithRssFeed}</div>
              <div>Pages with Atom feed: {reportSummary.pagesWithAtomFeed}</div>
              <div>Pages with JSON feed: {reportSummary.pagesWithJsonFeed}</div>
              <div>HTTPS 2xx missing HSTS: {reportSummary.httpsMissingHsts}</div>
              <div>HTTPS 2xx missing X-Content-Type-Options: {reportSummary.httpsMissingXContentTypeOptions}</div>
              <div>HTTPS 2xx missing X-Frame-Options: {reportSummary.httpsMissingXFrameOptions}</div>
              <div>HTTPS 2xx missing CSP: {reportSummary.httpsMissingCsp}</div>
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


