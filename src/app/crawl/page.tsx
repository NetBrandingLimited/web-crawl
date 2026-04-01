"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

const WORKER_STEPS_CAP = 4000;
const COMPARE_PREVIEW_DEBOUNCE_MS = 450;
/** Default page size for Phase 2 compare JSON (`paginate=1` on compare API). */
const DEFAULT_COMPARE_DIFF_PAGE_LIMIT = 500;
const DEFAULT_MAX_DEPTH = 10;
// Keep this close to the "about 500 URLs" target so the crawl doesn't explode.
const DEFAULT_MAX_PAGES = 600;
/** Page size for the Discovered URLs table (API allows up to 1000 per request). */
const URLS_TABLE_LIMIT = 500;
/** Past jobs / compare dropdowns: server allows up to 500 (see GET /api/v1/crawl-jobs). */
const JOB_LIST_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function describeFetchFailure(err: unknown, what: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const network =
    err instanceof TypeError ||
    msg === "Failed to fetch" ||
    msg === "NetworkError when attempting to fetch resource." ||
    msg.includes("Load failed");
  if (network) {
    return `${what}: the browser got no response (network error). Check that the Next dev server is running (npm run dev), you opened this page from that same origin (e.g. http://localhost:3000/crawl — not a file:// URL), and DATABASE_URL points to a reachable Postgres database.`;
  }
  return err instanceof Error ? err.message : "Request failed";
}

function escapeCsvCell(v: unknown): string {
  const raw = String(v ?? "");
  if (raw.includes('"') || raw.includes(",") || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

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

type CrawlJobListItem = {
  id: string;
  seedUrl: string;
  status: string;
  createdAt: string;
};
type CrawlJobListResponse = {
  items?: unknown;
  next_cursor?: unknown;
};

type CompareDiffCounts = {
  new_in_b: number;
  removed_in_a: number;
  changed: number;
  pages_in_a: number;
  pages_in_b: number;
};
type CompareChangeKind = "new_in_b" | "removed_in_a" | "changed";
type CompareChangedField =
  | "status"
  | "title"
  | "canonical"
  | "meta_description"
  | "word_count"
  | "h1_text"
  | "h1_count"
  | "content_type"
  | "robots_meta"
  | "meta_refresh"
  | "content_hash"
  | "x_robots_tag"
  | "html_lang"
  | "response_time_ms";
type ComparePresetId = "all" | "status" | "content" | "technical" | "performance";
type CompareSortKey = "kind" | "url" | "fields" | "status_a" | "status_b";

/** Fields used by quick presets (any match in `changed_fields` counts). */
const COMPARE_PRESET_FIELD_GROUPS: Record<Exclude<ComparePresetId, "all">, CompareChangedField[]> = {
  status: ["status"],
  content: ["title", "meta_description", "word_count", "h1_text", "h1_count", "content_hash"],
  technical: ["canonical", "robots_meta", "meta_refresh", "x_robots_tag", "html_lang", "content_type"],
  performance: ["response_time_ms"],
};

/** Same column order as server compare CSV (`src/app/api/v1/crawl-jobs/compare/route.ts`). */
const COMPARE_FULL_CSV_HEADERS = [
  "change_kind",
  "changed_fields",
  "url",
  "depth_a",
  "depth_b",
  "http_status_a",
  "http_status_b",
  "title_a",
  "title_b",
  "canonical_a",
  "canonical_b",
  "meta_description_a",
  "meta_description_b",
  "word_count_a",
  "word_count_b",
  "h1_text_a",
  "h1_text_b",
  "h1_count_a",
  "h1_count_b",
  "content_type_a",
  "content_type_b",
  "robots_meta_a",
  "robots_meta_b",
  "meta_refresh_a",
  "meta_refresh_b",
  "content_hash_a",
  "content_hash_b",
  "x_robots_tag_a",
  "x_robots_tag_b",
  "html_lang_a",
  "html_lang_b",
  "response_time_ms_a",
  "response_time_ms_b",
] as const;

type CompareFullCsvHeader = (typeof COMPARE_FULL_CSV_HEADERS)[number];

const COMPARE_EXPAND_FIELD_PAIRS: Array<{
  label: string;
  a: CompareFullCsvHeader;
  b: CompareFullCsvHeader;
}> = [
  { label: "Depth", a: "depth_a", b: "depth_b" },
  { label: "HTTP status", a: "http_status_a", b: "http_status_b" },
  { label: "Title", a: "title_a", b: "title_b" },
  { label: "Canonical", a: "canonical_a", b: "canonical_b" },
  { label: "Meta description", a: "meta_description_a", b: "meta_description_b" },
  { label: "Word count", a: "word_count_a", b: "word_count_b" },
  { label: "H1 text", a: "h1_text_a", b: "h1_text_b" },
  { label: "H1 count", a: "h1_count_a", b: "h1_count_b" },
  { label: "Content-Type", a: "content_type_a", b: "content_type_b" },
  { label: "Robots meta", a: "robots_meta_a", b: "robots_meta_b" },
  { label: "Meta refresh", a: "meta_refresh_a", b: "meta_refresh_b" },
  { label: "Content hash", a: "content_hash_a", b: "content_hash_b" },
  { label: "X-Robots-Tag", a: "x_robots_tag_a", b: "x_robots_tag_b" },
  { label: "HTML lang", a: "html_lang_a", b: "html_lang_b" },
  { label: "Response time (ms)", a: "response_time_ms_a", b: "response_time_ms_b" },
];

type CompareDiffRow = {
  change_kind: string;
  changed_fields: string;
  url: string;
  http_status_a: number | string;
  http_status_b: number | string;
  title_a: string;
  title_b: string;
  /** All compare columns (strings) for full CSV export; keys match server CSV. */
  fullRow: Record<CompareFullCsvHeader, string>;
};

function parseCompareApiRow(row: Record<string, unknown>): CompareDiffRow {
  const fullRow = Object.fromEntries(
    COMPARE_FULL_CSV_HEADERS.map((h) => [h, String(row[h] ?? "")]),
  ) as Record<CompareFullCsvHeader, string>;
  return {
    change_kind: fullRow.change_kind,
    changed_fields: fullRow.changed_fields,
    url: fullRow.url,
    http_status_a: (row.http_status_a as number | string | undefined) ?? "",
    http_status_b: (row.http_status_b as number | string | undefined) ?? "",
    title_a: fullRow.title_a,
    title_b: fullRow.title_b,
    fullRow,
  };
}

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
  | "success_non_html_urls"
  | "heavy_mailto_tel_outlinks"
  | "html_with_query_string"
  | "many_hreflang_alternates"
  | "missing_content_hash_html"
  | "deep_crawl_urls"
  | "image_heavy_html"
  | "many_json_ld_blocks"
  | "html_url_with_fragment"
  | "x_robots_tag_present"
  | "extra_long_titles"
  | "high_internal_link_ratio"
  | "robots_meta_no_x_robots_tag"
  | "single_h1_many_h2"
  | "heavy_mailto_outlinks"
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
  { id: "success_non_html_urls", label: "2xx Non-HTML URLs CSV" },
  { id: "heavy_mailto_tel_outlinks", label: "Heavy Mailto/Tel Outlinks CSV" },
  { id: "html_with_query_string", label: "HTML With Query String CSV" },
  { id: "many_hreflang_alternates", label: "Many hreflang Alternates (15+) CSV" },
  { id: "missing_content_hash_html", label: "Missing Content Hash (HTML) CSV" },
  { id: "deep_crawl_urls", label: "Deep Crawl URLs (depth 7+) CSV" },
  { id: "image_heavy_html", label: "Image-Heavy HTML (40+ imgs) CSV" },
  { id: "many_json_ld_blocks", label: "Many JSON-LD Blocks (5+) CSV" },
  { id: "html_url_with_fragment", label: "HTML URL With Fragment CSV" },
  { id: "x_robots_tag_present", label: "X-Robots-Tag Present CSV" },
  { id: "extra_long_titles", label: "Extra Long Titles (100+ chars) CSV" },
  { id: "high_internal_link_ratio", label: "High Internal Link Ratio CSV" },
  { id: "robots_meta_no_x_robots_tag", label: "Robots Meta Only (No X-Robots-Tag) CSV" },
  { id: "single_h1_many_h2", label: "Single H1, Many H2 (20+) CSV" },
  { id: "heavy_mailto_outlinks", label: "Heavy Mailto Outlinks (10+) CSV" },
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
  const [urlsNextCursor, setUrlsNextCursor] = useState<string | null>(null);
  const [urlsLoadingMore, setUrlsLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [crawlSteps, setCrawlSteps] = useState(0);
  const [reportSummary, setReportSummary] = useState<CrawlSummaryResponse["totals"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkZipBusy, setBulkZipBusy] = useState(false);
  const [bulkZipProgress, setBulkZipProgress] = useState<string | null>(null);
  const [jobsList, setJobsList] = useState<CrawlJobListItem[]>([]);
  const [compareJobA, setCompareJobA] = useState<string>("");
  const [compareJobB, setCompareJobB] = useState<string>("");
  const [compareDiffPreview, setCompareDiffPreview] = useState<{
    loading: boolean;
    loadingMore: boolean;
    counts: CompareDiffCounts | null;
    rows: CompareDiffRow[] | null;
    nextCursor: string | null;
    totalDiffRows: number | null;
  } | null>(null);
  const [compareTableFilterKind, setCompareTableFilterKind] = useState<"all" | CompareChangeKind>("all");
  const [compareTableFilterText, setCompareTableFilterText] = useState("");
  const [compareOnlyStatusChanges, setCompareOnlyStatusChanges] = useState(false);
  const [compareFieldFilter, setCompareFieldFilter] = useState<"all" | CompareChangedField>("all");
  /** When set, row must include at least one of these in `changed_fields` (presets). Manual single-field uses `compareFieldFilter` instead. */
  const [compareFieldAnyOf, setCompareFieldAnyOf] = useState<CompareChangedField[] | null>(null);
  const [comparePresetIncludeNewRemoved, setComparePresetIncludeNewRemoved] = useState(false);
  const [comparePreset, setComparePreset] = useState<ComparePresetId>("all");
  const [compareSortKey, setCompareSortKey] = useState<CompareSortKey>("kind");
  const [compareSortDir, setCompareSortDir] = useState<"asc" | "desc">("asc");
  const [compareDiffApiPageLimit, setCompareDiffApiPageLimit] = useState<200 | 500 | 1000>(DEFAULT_COMPARE_DIFF_PAGE_LIMIT);
  const [compareTablePage, setCompareTablePage] = useState(1);
  const [compareTablePageSize, setCompareTablePageSize] = useState<100 | 200 | 500>(200);
  const [comparePageJumpInput, setComparePageJumpInput] = useState("");
  const [expandedCompareRowKeys, setExpandedCompareRowKeys] = useState<Set<string>>(() => new Set());
  const [compareExpandOnlyChangedFields, setCompareExpandOnlyChangedFields] = useState(true);
  const [compareLinkCopied, setCompareLinkCopied] = useState(false);
  const [compareLoadMoreError, setCompareLoadMoreError] = useState<string | null>(null);
  const [compareAutoLoadAll, setCompareAutoLoadAll] = useState(false);
  const [compareExportAfterAutoLoad, setCompareExportAfterAutoLoad] = useState(false);
  const comparePreviewAbortRef = useRef<AbortController | null>(null);
  const applyingCompareFromUrl = useRef(false);
  const applyingCompareFiltersFromUrl = useRef(false);
  const pendingCompareFromUrlRef = useRef<{ a: string; b: string } | null>(null);
  const [urlTableFilter, setUrlTableFilter] = useState("");
  const [jobDeleteBusy, setJobDeleteBusy] = useState<string | null>(null);
  const [jobsListLoading, setJobsListLoading] = useState(false);
  const [jobsListLoadingMore, setJobsListLoadingMore] = useState(false);
  const [jobsListNextCursor, setJobsListNextCursor] = useState<string | null>(null);
  const [jobsListError, setJobsListError] = useState<string | null>(null);
  const [compareUrlHydrationNotice, setCompareUrlHydrationNotice] = useState<string | null>(null);
  const [jobDirectoryFilter, setJobDirectoryFilter] = useState("");
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [openJobByIdInput, setOpenJobByIdInput] = useState("");
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);

  const loadJobListForCompare = useCallback(async () => {
    setJobsListLoading(true);
    setJobsListError(null);
    setJobsListNextCursor(null);
    try {
      const res = await fetch(`/api/v1/crawl-jobs?limit=${JOB_LIST_LIMIT}`, { cache: "no-store" });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).trim();
        setJobsListError(
          `Could not load job list (HTTP ${res.status}).${detail ? ` ${detail.slice(0, 240)}` : ""}`,
        );
        return;
      }
      const json = (await res.json()) as CrawlJobListResponse;
      const items = Array.isArray(json.items) ? (json.items as CrawlJobListItem[]) : [];
      setJobsList(items);
      setJobsListNextCursor(typeof json.next_cursor === "string" && json.next_cursor ? json.next_cursor : null);
    } catch (e) {
      setJobsListError(describeFetchFailure(e, "Load job list"));
    } finally {
      setJobsListLoading(false);
    }
  }, []);

  const loadMoreJobsForCompare = useCallback(async () => {
    if (!jobsListNextCursor || jobsListLoadingMore || jobsListLoading) return;
    setJobsListLoadingMore(true);
    setJobsListError(null);
    try {
      const res = await fetch(
        `/api/v1/crawl-jobs?limit=${JOB_LIST_LIMIT}&cursor=${encodeURIComponent(jobsListNextCursor)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).trim();
        setJobsListError(
          `Could not load older jobs (HTTP ${res.status}).${detail ? ` ${detail.slice(0, 240)}` : ""}`,
        );
        return;
      }
      const json = (await res.json()) as CrawlJobListResponse;
      const items = Array.isArray(json.items) ? (json.items as CrawlJobListItem[]) : [];
      setJobsList((prev) => {
        const seen = new Set(prev.map((j) => j.id));
        const merged = [...prev];
        for (const it of items) {
          if (!seen.has(it.id)) merged.push(it);
        }
        return merged;
      });
      setJobsListNextCursor(typeof json.next_cursor === "string" && json.next_cursor ? json.next_cursor : null);
    } catch (e) {
      setJobsListError(describeFetchFailure(e, "Load older jobs"));
    } finally {
      setJobsListLoadingMore(false);
    }
  }, [jobsListLoading, jobsListLoadingMore, jobsListNextCursor]);

  useEffect(() => {
    void loadJobListForCompare();
  }, [loadJobListForCompare]);

  useEffect(() => {
    if (jobId) setCompareJobB((prev) => prev || jobId);
  }, [jobId]);

  useEffect(() => {
    if (jobsList.length === 0) {
      setSelectedJobIds([]);
      return;
    }
    const ids = new Set(jobsList.map((j) => j.id));
    setSelectedJobIds((prev) => prev.filter((id) => ids.has(id)));
  }, [jobsList]);

  /** Drop compare selections that no longer exist in the loaded job list. */
  useEffect(() => {
    if (jobsList.length === 0) return;
    const ids = new Set(jobsList.map((j) => j.id));
    setCompareJobA((p) => (p && !ids.has(p) ? "" : p));
    setCompareJobB((p) => (p && !ids.has(p) ? "" : p));
  }, [jobsList]);

  /** Apply compareA/compareB from the URL once the job list is available (does not wipe URL while list is still empty). */
  useEffect(() => {
    const url = new URL(window.location.href);
    const a = url.searchParams.get("compareA") ?? url.searchParams.get("a");
    const b = url.searchParams.get("compareB") ?? url.searchParams.get("b");
    if (!a || !b || a === b) return;
    pendingCompareFromUrlRef.current = { a, b };
    setCompareUrlHydrationNotice(null);
  }, []);

  /** Apply compare filter controls from URL once on first load. */
  useEffect(() => {
    const url = new URL(window.location.href);
    const kind = url.searchParams.get("ck");
    const field = url.searchParams.get("cf");
    const query = url.searchParams.get("cq");
    const statusOnly = url.searchParams.get("cs");
    const preset = url.searchParams.get("cp");
    const includeNr = url.searchParams.get("cnr");
    const sortKey = url.searchParams.get("csk");
    const sortDir = url.searchParams.get("csd");
    const expandedChangedOnly = url.searchParams.get("ceco");
    const tablePage = url.searchParams.get("ctp");
    const tablePageSize = url.searchParams.get("ctps");
    const diffApiLimit = url.searchParams.get("cdl");
    applyingCompareFiltersFromUrl.current = true;
    if (kind === "all" || kind === "changed" || kind === "new_in_b" || kind === "removed_in_a") {
      setCompareTableFilterKind(kind);
    }
    if (
      field === "all" ||
      field === "status" ||
      field === "title" ||
      field === "canonical" ||
      field === "meta_description" ||
      field === "word_count" ||
      field === "h1_text" ||
      field === "h1_count" ||
      field === "content_type" ||
      field === "robots_meta" ||
      field === "meta_refresh" ||
      field === "content_hash" ||
      field === "x_robots_tag" ||
      field === "html_lang" ||
      field === "response_time_ms"
    ) {
      setCompareFieldFilter(field);
    }
    if (typeof query === "string") setCompareTableFilterText(query);
    if (statusOnly === "1") setCompareOnlyStatusChanges(true);
    if (includeNr === "1") setComparePresetIncludeNewRemoved(true);
    if (
      sortKey === "kind" ||
      sortKey === "url" ||
      sortKey === "fields" ||
      sortKey === "status_a" ||
      sortKey === "status_b"
    ) {
      setCompareSortKey(sortKey);
    }
    if (sortDir === "asc" || sortDir === "desc") {
      setCompareSortDir(sortDir);
    }
    if (expandedChangedOnly === "0") {
      setCompareExpandOnlyChangedFields(false);
    } else if (expandedChangedOnly === "1") {
      setCompareExpandOnlyChangedFields(true);
    }
    if (tablePageSize === "100" || tablePageSize === "200" || tablePageSize === "500") {
      setCompareTablePageSize(Number(tablePageSize) as 100 | 200 | 500);
    }
    if (diffApiLimit === "200" || diffApiLimit === "500" || diffApiLimit === "1000") {
      setCompareDiffApiPageLimit(Number(diffApiLimit) as 200 | 500 | 1000);
    }
    if (tablePage && Number.isFinite(Number(tablePage))) {
      setCompareTablePage(Math.max(1, Math.floor(Number(tablePage))));
    }
    if (preset === "all" || preset === "status" || preset === "content" || preset === "technical" || preset === "performance") {
      setComparePreset(preset);
      if (preset === "all") {
        setCompareFieldAnyOf(null);
      } else {
        setCompareFieldAnyOf(COMPARE_PRESET_FIELD_GROUPS[preset]);
        setCompareTableFilterKind("changed");
        setCompareFieldFilter("all");
      }
    }
    window.setTimeout(() => {
      applyingCompareFiltersFromUrl.current = false;
    }, 0);
  }, []);

  /** Apply compareA/compareB from the URL; auto-page older jobs until both IDs are found (or exhausted). */
  useEffect(() => {
    const pending = pendingCompareFromUrlRef.current;
    if (!pending) return;
    if (jobsList.length === 0) return;

    const { a, b } = pending;
    const ids = new Set(jobsList.map((j) => j.id));
    if (!ids.has(a) || !ids.has(b)) {
      if (jobsListNextCursor && !jobsListLoading && !jobsListLoadingMore) {
        void loadMoreJobsForCompare();
        return;
      }
      if (!jobsListNextCursor) {
        pendingCompareFromUrlRef.current = null;
        setCompareUrlHydrationNotice(
          "Could not resolve compareA/compareB from URL in loaded job history. The jobs may be deleted or the IDs may be invalid.",
        );
      }
      return;
    }
    applyingCompareFromUrl.current = true;
    setCompareJobA(a);
    setCompareJobB(b);
    pendingCompareFromUrlRef.current = null;
    setCompareUrlHydrationNotice(null);
  }, [jobsList, jobsListLoading, jobsListLoadingMore, jobsListNextCursor, loadMoreJobsForCompare]);

  useEffect(() => {
    if (applyingCompareFromUrl.current) {
      applyingCompareFromUrl.current = false;
      return;
    }
    // Avoid stripping compare* from the URL before the job list has loaded (would break bookmarked links).
    if (!compareJobA && !compareJobB && jobsList.length === 0) return;

    const url = new URL(window.location.href);
    if (compareJobA && compareJobB && compareJobA !== compareJobB) {
      url.searchParams.set("compareA", compareJobA);
      url.searchParams.set("compareB", compareJobB);
    } else {
      url.searchParams.delete("compareA");
      url.searchParams.delete("compareB");
      url.searchParams.delete("a");
      url.searchParams.delete("b");
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState({}, "", next);
    }
  }, [compareJobA, compareJobB, jobsList.length]);

  /** Keep compare filter controls in URL for shareable deep links. */
  useEffect(() => {
    if (applyingCompareFiltersFromUrl.current) return;
    const url = new URL(window.location.href);
    if (compareTableFilterKind !== "all") url.searchParams.set("ck", compareTableFilterKind);
    else url.searchParams.delete("ck");
    if (compareFieldFilter !== "all") url.searchParams.set("cf", compareFieldFilter);
    else url.searchParams.delete("cf");
    if (compareTableFilterText.trim() !== "") url.searchParams.set("cq", compareTableFilterText.trim());
    else url.searchParams.delete("cq");
    if (compareOnlyStatusChanges) url.searchParams.set("cs", "1");
    else url.searchParams.delete("cs");
    if (comparePreset !== "all") url.searchParams.set("cp", comparePreset);
    else url.searchParams.delete("cp");
    if (comparePresetIncludeNewRemoved) url.searchParams.set("cnr", "1");
    else url.searchParams.delete("cnr");
    if (compareSortKey !== "kind") url.searchParams.set("csk", compareSortKey);
    else url.searchParams.delete("csk");
    if (compareSortDir !== "asc") url.searchParams.set("csd", compareSortDir);
    else url.searchParams.delete("csd");
    if (!compareExpandOnlyChangedFields) url.searchParams.set("ceco", "0");
    else url.searchParams.delete("ceco");
    if (compareTablePageSize !== 200) url.searchParams.set("ctps", String(compareTablePageSize));
    else url.searchParams.delete("ctps");
    if (compareTablePage > 1) url.searchParams.set("ctp", String(compareTablePage));
    else url.searchParams.delete("ctp");
    if (compareDiffApiPageLimit !== DEFAULT_COMPARE_DIFF_PAGE_LIMIT)
      url.searchParams.set("cdl", String(compareDiffApiPageLimit));
    else url.searchParams.delete("cdl");
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState({}, "", next);
    }
  }, [
    compareFieldFilter,
    compareOnlyStatusChanges,
    comparePreset,
    comparePresetIncludeNewRemoved,
    compareExpandOnlyChangedFields,
    compareDiffApiPageLimit,
    compareTablePage,
    compareTablePageSize,
    compareSortDir,
    compareSortKey,
    compareTableFilterKind,
    compareTableFilterText,
  ]);

  useEffect(() => {
    if (!compareJobA || !compareJobB || compareJobA === compareJobB) {
      comparePreviewAbortRef.current?.abort();
      comparePreviewAbortRef.current = null;
      setCompareDiffPreview(null);
      setCompareLoadMoreError(null);
      setCompareAutoLoadAll(false);
      setCompareExportAfterAutoLoad(false);
      return;
    }
    setCompareLoadMoreError(null);
    setCompareDiffPreview({
      loading: true,
      loadingMore: false,
      counts: null,
      rows: null,
      nextCursor: null,
      totalDiffRows: null,
    });
    const timeoutId = window.setTimeout(() => {
      comparePreviewAbortRef.current?.abort();
      const ac = new AbortController();
      comparePreviewAbortRef.current = ac;
      const u = `/api/v1/crawl-jobs/compare?a=${encodeURIComponent(compareJobA)}&b=${encodeURIComponent(compareJobB)}&format=json&paginate=1&limit=${compareDiffApiPageLimit}`;
      void (async () => {
        try {
          const res = await fetch(u, { cache: "no-store", signal: ac.signal });
          if (!res.ok) {
            if (!ac.signal.aborted) setCompareDiffPreview(null);
            return;
          }
          const json = (await res.json()) as {
            counts?: CompareDiffCounts;
            rows?: unknown;
            next_cursor?: string | null;
            total_diff_rows?: number;
          };
          const c = json.counts;
          const rawRows = Array.isArray(json.rows) ? json.rows : [];
          const rows = rawRows
            .filter((r) => typeof r === "object" && r !== null)
            .map((r) => parseCompareApiRow(r as Record<string, unknown>));
          if (ac.signal.aborted) return;
          if (
            c &&
            typeof c.new_in_b === "number" &&
            typeof c.removed_in_a === "number" &&
            typeof c.changed === "number" &&
            typeof c.pages_in_a === "number" &&
            typeof c.pages_in_b === "number"
          ) {
            const nextC = json.next_cursor;
            const total = json.total_diff_rows;
            setCompareDiffPreview({
              loading: false,
              loadingMore: false,
              counts: c,
              rows,
              nextCursor: typeof nextC === "string" && nextC ? nextC : null,
              totalDiffRows: typeof total === "number" ? total : rows.length,
            });
          } else {
            setCompareDiffPreview(null);
          }
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") return;
          if (!ac.signal.aborted) setCompareDiffPreview(null);
        }
      })();
    }, COMPARE_PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timeoutId);
      comparePreviewAbortRef.current?.abort();
      comparePreviewAbortRef.current = null;
    };
  }, [compareDiffApiPageLimit, compareJobA, compareJobB]);

  useEffect(() => {
    setExpandedCompareRowKeys(new Set());
  }, [compareJobA, compareJobB]);

  const filteredCompareRows = useMemo(() => {
    const rows = compareDiffPreview?.rows ?? [];
    const kind = compareTableFilterKind;
    const q = compareTableFilterText.trim().toLowerCase();
    return rows.filter((r) => {
      if (kind !== "all" && r.change_kind !== kind) return false;
      const fields = r.changed_fields
        .split("|")
        .map((f) => f.trim())
        .filter(Boolean);
      if (compareFieldAnyOf && compareFieldAnyOf.length > 0) {
        if (r.change_kind === "changed") {
          if (!compareFieldAnyOf.some((f) => fields.includes(f))) return false;
        } else if (!comparePresetIncludeNewRemoved) {
          return false;
        }
      } else if (compareFieldFilter !== "all" && !fields.includes(compareFieldFilter)) {
        return false;
      }
      if (compareOnlyStatusChanges) {
        if (!fields.includes("status")) return false;
      }
      if (!q) return true;
      const blob = COMPARE_FULL_CSV_HEADERS.map((h) => r.fullRow[h]).join("\n").toLowerCase();
      return blob.includes(q);
    });
  }, [
    compareDiffPreview?.rows,
    comparePresetIncludeNewRemoved,
    compareFieldAnyOf,
    compareFieldFilter,
    compareOnlyStatusChanges,
    compareTableFilterKind,
    compareTableFilterText,
  ]);

  const sortedFilteredCompareRows = useMemo(() => {
    const rows = [...filteredCompareRows];
    const dir = compareSortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const val = (r: CompareDiffRow): string | number => {
        if (compareSortKey === "kind") return r.change_kind;
        if (compareSortKey === "url") return r.url;
        if (compareSortKey === "fields") return r.changed_fields;
        if (compareSortKey === "status_a") return Number(r.http_status_a || 0);
        return Number(r.http_status_b || 0);
      };
      const av = val(a);
      const bv = val(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }, [filteredCompareRows, compareSortDir, compareSortKey]);
  useEffect(() => {
    setCompareTablePage(1);
  }, [filteredCompareRows.length, compareSortDir, compareSortKey, compareTablePageSize]);
  const compareTableTotalPages = useMemo(
    () => Math.max(1, Math.ceil(sortedFilteredCompareRows.length / compareTablePageSize)),
    [compareTablePageSize, sortedFilteredCompareRows.length],
  );
  useEffect(() => {
    setCompareTablePage((p) => Math.min(Math.max(1, p), compareTableTotalPages));
  }, [compareTableTotalPages]);
  useEffect(() => {
    setComparePageJumpInput(String(compareTablePage));
  }, [compareTablePage]);
  const visibleSortedCompareRows = useMemo(() => {
    const start = (compareTablePage - 1) * compareTablePageSize;
    return sortedFilteredCompareRows.slice(start, start + compareTablePageSize);
  }, [compareTablePage, compareTablePageSize, sortedFilteredCompareRows]);
  const compareRemainingRows = useMemo(() => {
    const total = compareDiffPreview?.totalDiffRows ?? 0;
    const loaded = compareDiffPreview?.rows?.length ?? 0;
    return Math.max(0, total - loaded);
  }, [compareDiffPreview?.rows?.length, compareDiffPreview?.totalDiffRows]);
  const compareEstimatedRemainingPages = useMemo(() => {
    if (!compareDiffPreview?.nextCursor) return 0;
    return Math.ceil(compareRemainingRows / compareDiffApiPageLimit);
  }, [compareDiffApiPageLimit, compareDiffPreview?.nextCursor, compareRemainingRows]);
  const filteredCompareKindCounts = useMemo(() => {
    let changed = 0;
    let newInB = 0;
    let removedInA = 0;
    for (const r of filteredCompareRows) {
      if (r.change_kind === "changed") changed += 1;
      else if (r.change_kind === "new_in_b") newInB += 1;
      else if (r.change_kind === "removed_in_a") removedInA += 1;
    }
    return { changed, newInB, removedInA };
  }, [filteredCompareRows]);

  const loadMoreCompareDiffs = useCallback(() => {
    if (!compareJobA || !compareJobB || compareJobA === compareJobB) return;
    setCompareLoadMoreError(null);
    setCompareDiffPreview((p) => {
      if (!p?.nextCursor || p.loadingMore || p.loading) return p;
      const cursor = p.nextCursor;
      void (async () => {
        try {
          const u = `/api/v1/crawl-jobs/compare?a=${encodeURIComponent(compareJobA)}&b=${encodeURIComponent(compareJobB)}&format=json&paginate=1&limit=${compareDiffApiPageLimit}&cursor=${encodeURIComponent(cursor)}`;
          const res = await fetch(u, { cache: "no-store" });
          if (!res.ok) {
            const detail = (await res.text().catch(() => "")).trim();
            setCompareLoadMoreError(
              `Could not load more diffs (HTTP ${res.status}).${detail ? ` ${detail.slice(0, 180)}` : ""}`,
            );
            setCompareAutoLoadAll(false);
            setCompareExportAfterAutoLoad(false);
            setCompareDiffPreview((prev) => (prev ? { ...prev, loadingMore: false } : prev));
            return;
          }
          const json = (await res.json()) as {
            rows?: unknown;
            next_cursor?: string | null;
            total_diff_rows?: number;
          };
          const rawRows = Array.isArray(json.rows) ? json.rows : [];
          const newRows = rawRows
            .filter((r) => typeof r === "object" && r !== null)
            .map((r) => parseCompareApiRow(r as Record<string, unknown>));
          setCompareDiffPreview((prev) => {
            if (!prev) return prev;
            const base = prev.rows ?? [];
            const seen = new Set(base.map((r) => `${r.change_kind}\t${r.url}`));
            const merged = [...base];
            for (const r of newRows) {
              const k = `${r.change_kind}\t${r.url}`;
              if (!seen.has(k)) {
                seen.add(k);
                merged.push(r);
              }
            }
            const nextC = json.next_cursor;
            const total = json.total_diff_rows;
            return {
              ...prev,
              loadingMore: false,
              rows: merged,
              nextCursor: typeof nextC === "string" && nextC ? nextC : null,
              totalDiffRows: typeof total === "number" ? total : prev.totalDiffRows,
            };
          });
        } catch {
          setCompareLoadMoreError("Could not load more diffs (network error).");
          setCompareAutoLoadAll(false);
          setCompareExportAfterAutoLoad(false);
          setCompareDiffPreview((prev) => (prev ? { ...prev, loadingMore: false } : prev));
        }
      })();
      return { ...p, loadingMore: true };
    });
  }, [compareDiffApiPageLimit, compareJobA, compareJobB]);

  useEffect(() => {
    if (!compareAutoLoadAll) return;
    if (!compareDiffPreview || compareDiffPreview.loading || compareDiffPreview.loadingMore) return;
    if (!compareDiffPreview.nextCursor) {
      setCompareAutoLoadAll(false);
      return;
    }
    const t = window.setTimeout(() => {
      loadMoreCompareDiffs();
    }, 120);
    return () => window.clearTimeout(t);
  }, [compareAutoLoadAll, compareDiffPreview, loadMoreCompareDiffs]);

  useEffect(() => {
    if (!compareExportAfterAutoLoad) return;
    if (!compareDiffPreview || compareDiffPreview.loading || compareDiffPreview.loadingMore) return;
    if (compareDiffPreview.nextCursor) {
      if (!compareAutoLoadAll) setCompareAutoLoadAll(true);
      return;
    }
    if (filteredCompareRows.length === 0) {
      setCompareExportAfterAutoLoad(false);
      setCompareAutoLoadAll(false);
      setError("No compare rows match the current filters.");
      return;
    }
    downloadFilteredCompareFullCsv();
    setCompareExportAfterAutoLoad(false);
    setCompareAutoLoadAll(false);
  }, [compareAutoLoadAll, compareDiffPreview, compareExportAfterAutoLoad, filteredCompareRows.length]);

  function applyComparePreset(preset: ComparePresetId, includeNewRemoved = false) {
    setComparePreset(preset);
    if (preset === "all") {
      setCompareTableFilterKind("all");
      setCompareFieldFilter("all");
      setCompareFieldAnyOf(null);
      setCompareOnlyStatusChanges(false);
      setComparePresetIncludeNewRemoved(false);
      return;
    }
    setCompareTableFilterKind("changed");
    setCompareFieldFilter("all");
    setCompareFieldAnyOf(COMPARE_PRESET_FIELD_GROUPS[preset]);
    setCompareOnlyStatusChanges(false);
    setComparePresetIncludeNewRemoved(includeNewRemoved);
  }

  function setCompareSortFromHeader(nextKey: CompareSortKey) {
    setCompareSortKey((prev) => {
      if (prev === nextKey) {
        setCompareSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setCompareSortDir("asc");
      return nextKey;
    });
  }

  function toggleCompareRowExpanded(rowKey: string) {
    setExpandedCompareRowKeys((prev) => {
      const n = new Set(prev);
      if (n.has(rowKey)) n.delete(rowKey);
      else n.add(rowKey);
      return n;
    });
  }

  function expandAllVisibleCompareRows() {
    setExpandedCompareRowKeys((prev) => {
      const n = new Set(prev);
      for (const r of visibleSortedCompareRows) n.add(`${r.change_kind}\t${r.url}`);
      return n;
    });
  }

  function collapseAllVisibleCompareRows() {
    setExpandedCompareRowKeys((prev) => {
      const n = new Set(prev);
      for (const r of visibleSortedCompareRows) n.delete(`${r.change_kind}\t${r.url}`);
      return n;
    });
  }

  function expandAllLoadedCompareRows() {
    setExpandedCompareRowKeys((prev) => {
      const n = new Set(prev);
      for (const r of sortedFilteredCompareRows) n.add(`${r.change_kind}\t${r.url}`);
      return n;
    });
  }

  function collapseAllLoadedCompareRows() {
    setExpandedCompareRowKeys((prev) => {
      const n = new Set(prev);
      for (const r of sortedFilteredCompareRows) n.delete(`${r.change_kind}\t${r.url}`);
      return n;
    });
  }

  function goToComparePageFromInput() {
    const n = Number(comparePageJumpInput);
    if (!Number.isFinite(n) || n < 1) {
      setCompareTablePage(1);
      return;
    }
    setCompareTablePage(Math.min(compareTableTotalPages, Math.floor(n)));
  }

  function toggleCompareKindQuickFilter(kind: CompareChangeKind) {
    setCompareTableFilterKind((prev) => (prev === kind ? "all" : kind));
    setComparePreset("all");
    setCompareFieldAnyOf(null);
  }

  function quickFilterByChangedField(field: CompareChangedField) {
    setComparePreset("all");
    setCompareFieldAnyOf(null);
    setCompareTableFilterKind("changed");
    setCompareOnlyStatusChanges(false);
    setCompareFieldFilter(field);
  }

  useEffect(() => {
    setUrlTableFilter("");
  }, [jobId]);

  const filteredUrls = useMemo(() => {
    const q = urlTableFilter.trim().toLowerCase();
    if (!q) return urls;
    return urls.filter((u) => {
      const blob = `${u.original_url}\n${u.title ?? ""}\n${u.http_status ?? ""}\n${u._queue_state}`.toLowerCase();
      return blob.includes(q);
    });
  }, [urls, urlTableFilter]);

  const filteredJobsDirectory = useMemo(() => {
    const q = jobDirectoryFilter.trim().toLowerCase();
    if (!q) return jobsList;
    return jobsList.filter((j) => {
      const blob = `${j.seedUrl}\n${j.status}\n${j.id}\n${new Date(j.createdAt).toLocaleString()}`.toLowerCase();
      return blob.includes(q);
    });
  }, [jobsList, jobDirectoryFilter]);

  const comparePickOptionsA = useMemo(() => {
    const base = filteredJobsDirectory;
    if (compareJobA && !base.some((j) => j.id === compareJobA)) {
      const extra = jobsList.find((j) => j.id === compareJobA);
      return extra ? [extra, ...base] : base;
    }
    return base;
  }, [filteredJobsDirectory, jobsList, compareJobA]);

  const comparePickOptionsB = useMemo(() => {
    const base = filteredJobsDirectory;
    if (compareJobB && !base.some((j) => j.id === compareJobB)) {
      const extra = jobsList.find((j) => j.id === compareJobB);
      return extra ? [extra, ...base] : base;
    }
    return base;
  }, [filteredJobsDirectory, jobsList, compareJobB]);

  const allFilteredJobsSelected = useMemo(() => {
    if (filteredJobsDirectory.length === 0) return false;
    return filteredJobsDirectory.every((j) => selectedJobIds.includes(j.id));
  }, [filteredJobsDirectory, selectedJobIds]);
  const searchingOlderJobsForUrlCompare = useMemo(() => {
    const pending = pendingCompareFromUrlRef.current;
    if (!pending) return false;
    return Boolean(jobsListNextCursor) && (jobsListLoadingMore || jobsListLoading);
  }, [jobsListLoading, jobsListLoadingMore, jobsListNextCursor, jobsList.length]);

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
      setError(describeFetchFailure(e, "Crawl worker"));
    } finally {
      setCrawling(false);
    }
  }

  async function start() {
    setLoading(true);
    setError(null);
    setUrls([]);
    setUrlsNextCursor(null);
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
      setError(describeFetchFailure(e, "Start crawl"));
    } finally {
      setLoading(false);
      void loadJobListForCompare();
    }
  }

  async function runWorkerOnly() {
    if (!jobId) return;
    await drainWorkerForJob(jobId);
  }

  async function refresh(id?: string) {
    const effectiveId = id ?? jobId;
    if (!effectiveId) return;
    setRefreshing(true);
    try {
      setError(null);
      const res = await fetch(`/api/v1/crawl-jobs/${effectiveId}`, { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 404 ? "Crawl job not found." : `Could not load job status (${res.status}).`);
        return;
      }
      setStatus((await res.json()) as CrawlJobStatusResponse);
      const summaryRes = await fetch(`/api/v1/crawl-jobs/${effectiveId}/reports?report=summary`, {
        cache: "no-store",
      });
      if (summaryRes.ok) {
        const summaryJson = (await summaryRes.json()) as CrawlSummaryResponse;
        setReportSummary(summaryJson.totals);
      }
      await loadUrls(effectiveId);
    } catch (e) {
      setError(describeFetchFailure(e, "Refresh crawl job"));
    } finally {
      setRefreshing(false);
    }
  }

  async function loadUrls(id?: string) {
    const effectiveId = id ?? jobId;
    if (!effectiveId) return;
    const res = await fetch(`/api/v1/crawl-jobs/${effectiveId}/urls?limit=${URLS_TABLE_LIMIT}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as CrawlUrlsResponse;
    setUrls(json.items);
    setUrlsNextCursor(json.next_cursor);
  }

  async function loadMoreUrls() {
    if (!jobId || !urlsNextCursor || urlsLoadingMore) return;
    setUrlsLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/crawl-jobs/${jobId}/urls?limit=${URLS_TABLE_LIMIT}&cursor=${encodeURIComponent(urlsNextCursor)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as CrawlUrlsResponse;
      setUrls((prev) => [...prev, ...json.items]);
      setUrlsNextCursor(json.next_cursor);
    } finally {
      setUrlsLoadingMore(false);
    }
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

  async function downloadAllReportsZip() {
    if (!jobId) return;
    if (urls.length === 0) {
      setError("No crawl URLs found for this job yet. Start/continue crawl, then refresh.");
      return;
    }
    setBulkZipBusy(true);
    setBulkZipProgress("Loading…");
    setError(null);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const csvFolder = zip.folder("csv");
      const xmlFolder = zip.folder("xml");
      const jsonFolder = zip.folder("json");
      if (!csvFolder || !xmlFolder || !jsonFolder) throw new Error("Could not create csv/, xml/, or json/ in ZIP");

      const entries: Array<{ folder: typeof csvFolder; name: string; url: string }> = REPORT_BUTTONS.map(
        (r) => ({
          folder: csvFolder,
          name: `${r.id}.csv`,
          url: `/api/v1/crawl-jobs/${jobId}/reports?report=${encodeURIComponent(r.id)}&format=csv`,
        }),
      );
      entries.push({
        folder: xmlFolder,
        name: "sitemap.xml",
        url: `/api/v1/crawl-jobs/${jobId}/sitemap`,
      });
      entries.push({
        folder: jsonFolder,
        name: "summary.json",
        url: `/api/v1/crawl-jobs/${jobId}/reports?report=summary`,
      });

      const concurrency = 6;
      for (let i = 0; i < entries.length; i += concurrency) {
        const slice = entries.slice(i, i + concurrency);
        const done = Math.min(i + slice.length, entries.length);
        setBulkZipProgress(`Downloading ${done} / ${entries.length}…`);
        await Promise.all(
          slice.map(async (e) => {
            const res = await fetch(e.url, { cache: "no-store" });
            if (!res.ok) {
              const t = await res.text().catch(() => "");
              throw new Error(
                `${e.name}: HTTP ${res.status}${t ? ` — ${t.slice(0, 120)}` : ""}`,
              );
            }
            if (e.name === "summary.json") {
              const data = (await res.json()) as unknown;
              e.folder.file(e.name, JSON.stringify(data, null, 2));
            } else {
              const buf = await res.arrayBuffer();
              e.folder.file(e.name, buf);
            }
          }),
        );
      }

      setBulkZipProgress("Building ZIP…");
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `crawl-export-${jobId.slice(0, 8)}.zip`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setError(describeFetchFailure(e, "Download all (ZIP)"));
    } finally {
      setBulkZipBusy(false);
      setBulkZipProgress(null);
    }
  }

  function downloadCompareCsv() {
    if (!compareJobA || !compareJobB) {
      setError("Choose baseline job (A) and compare job (B).");
      return;
    }
    if (compareJobA === compareJobB) {
      setError("Pick two different crawl jobs for comparison.");
      return;
    }
    const u = `/api/v1/crawl-jobs/compare?a=${encodeURIComponent(compareJobA)}&b=${encodeURIComponent(compareJobB)}&format=csv`;
    triggerDownload(u);
  }

  async function downloadCompareJson() {
    if (!compareJobA || !compareJobB) {
      setError("Choose baseline job (A) and compare job (B).");
      return;
    }
    if (compareJobA === compareJobB) {
      setError("Pick two different crawl jobs for comparison.");
      return;
    }
    setError(null);
    const u = `/api/v1/crawl-jobs/compare?a=${encodeURIComponent(compareJobA)}&b=${encodeURIComponent(compareJobB)}&format=json`;
    try {
      const res = await fetch(u, { cache: "no-store" });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(errBody?.message ?? `Compare JSON failed (${res.status}).`);
        return;
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `crawl-compare-${compareJobA.slice(0, 8)}-${compareJobB.slice(0, 8)}.json`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setError(describeFetchFailure(e, "Download compare JSON"));
    }
  }

  function clearCompareSelections() {
    comparePreviewAbortRef.current?.abort();
    comparePreviewAbortRef.current = null;
    setCompareDiffPreview(null);
    setCompareJobA("");
    setCompareJobB("");
  }

  function resetCompareViewControls() {
    setCompareTableFilterKind("all");
    setCompareTableFilterText("");
    setCompareOnlyStatusChanges(false);
    setCompareFieldFilter("all");
    setCompareFieldAnyOf(null);
    setComparePresetIncludeNewRemoved(false);
    setComparePreset("all");
    setCompareSortKey("kind");
    setCompareSortDir("asc");
    setCompareDiffApiPageLimit(DEFAULT_COMPARE_DIFF_PAGE_LIMIT);
    setCompareTablePageSize(200);
    setCompareTablePage(1);
    setCompareExpandOnlyChangedFields(true);
    setExpandedCompareRowKeys(new Set());
    setCompareAutoLoadAll(false);
    setCompareExportAfterAutoLoad(false);
  }

  function clearCompareActiveFilters() {
    setCompareTableFilterKind("all");
    setCompareFieldFilter("all");
    setCompareTableFilterText("");
    setCompareOnlyStatusChanges(false);
    setComparePreset("all");
    setCompareFieldAnyOf(null);
    setComparePresetIncludeNewRemoved(false);
    setCompareTablePage(1);
  }

  function downloadFilteredComparePreviewCsv() {
    setError(null);
    if (!compareJobA || !compareJobB) {
      setError("Choose baseline job (A) and compare job (B).");
      return;
    }
    if (filteredCompareRows.length === 0) {
      setError("No compare rows match the current filters.");
      return;
    }
    const headers = ["change_kind", "changed_fields", "url", "http_status_a", "http_status_b", "title_a", "title_b"];
    const lines = [headers.join(",")];
    for (const r of filteredCompareRows) {
      lines.push(
        [
          escapeCsvCell(r.change_kind),
          escapeCsvCell(r.changed_fields),
          escapeCsvCell(r.url),
          escapeCsvCell(r.http_status_a),
          escapeCsvCell(r.http_status_b),
          escapeCsvCell(r.title_a),
          escapeCsvCell(r.title_b),
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `crawl-compare-filtered-${compareJobA.slice(0, 8)}-${compareJobB.slice(0, 8)}.csv`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  function downloadFilteredCompareFullCsv() {
    setError(null);
    if (!compareJobA || !compareJobB) {
      setError("Choose baseline job (A) and compare job (B).");
      return;
    }
    if (filteredCompareRows.length === 0) {
      setError("No compare rows match the current filters.");
      return;
    }
    const lines = [COMPARE_FULL_CSV_HEADERS.join(",")];
    for (const r of filteredCompareRows) {
      lines.push(COMPARE_FULL_CSV_HEADERS.map((h) => escapeCsvCell(r.fullRow[h])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `crawl-compare-filtered-full-${compareJobA.slice(0, 8)}-${compareJobB.slice(0, 8)}.csv`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  function downloadVisibleComparePageCsv() {
    setError(null);
    if (!compareJobA || !compareJobB) {
      setError("Choose baseline job (A) and compare job (B).");
      return;
    }
    if (visibleSortedCompareRows.length === 0) {
      setError("No compare rows on the current page.");
      return;
    }
    const lines = [COMPARE_FULL_CSV_HEADERS.join(",")];
    for (const r of visibleSortedCompareRows) {
      lines.push(COMPARE_FULL_CSV_HEADERS.map((h) => escapeCsvCell(r.fullRow[h])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `crawl-compare-page-${compareTablePage}-${compareJobA.slice(0, 8)}-${compareJobB.slice(0, 8)}.csv`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  function autoLoadAllAndExportFilteredCsv() {
    setError(null);
    if (!compareJobA || !compareJobB || compareJobA === compareJobB) {
      setError("Choose baseline job (A) and compare job (B).");
      return;
    }
    setCompareExportAfterAutoLoad(true);
    if (compareDiffPreview?.nextCursor) setCompareAutoLoadAll(true);
  }

  function cancelAutoLoadExportWorkflow() {
    setCompareAutoLoadAll(false);
    setCompareExportAfterAutoLoad(false);
  }

  function retryAutoLoadFromHere() {
    if (!compareDiffPreview?.nextCursor) {
      setCompareLoadMoreError("No remaining compare pages to auto-load.");
      return;
    }
    setCompareLoadMoreError(null);
    setCompareAutoLoadAll(true);
  }

  async function copyCompareDeepLink() {
    setError(null);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCompareLinkCopied(true);
      window.setTimeout(() => setCompareLinkCopied(false), 1800);
    } catch {
      setError("Could not copy compare link (clipboard blocked or unavailable).");
    }
  }

  async function openJobInViewer(id: string): Promise<boolean> {
    setError(null);
    const res = await fetch(`/api/v1/crawl-jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) {
      setError(res.status === 404 ? "No crawl job with that id." : `Could not load job (${res.status}).`);
      return false;
    }
    setJobId(id);
    setCompareJobB((prev) => prev || id);
    setUrlTableFilter("");
    setStatus((await res.json()) as CrawlJobStatusResponse);
    const summaryRes = await fetch(`/api/v1/crawl-jobs/${id}/reports?report=summary`, { cache: "no-store" });
    if (summaryRes.ok) {
      const summaryJson = (await summaryRes.json()) as CrawlSummaryResponse;
      setReportSummary(summaryJson.totals);
    }
    await loadUrls(id);
    return true;
  }

  async function openJobByPastedId() {
    const raw = openJobByIdInput.trim();
    if (!raw) {
      setError("Paste a crawl job UUID.");
      return;
    }
    if (!UUID_RE.test(raw)) {
      setError("That does not look like a crawl job UUID (8-4-4-4-12 hex).");
      return;
    }
    const ok = await openJobInViewer(raw);
    if (ok) setOpenJobByIdInput("");
  }

  async function copyJobId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedJobId(id);
      window.setTimeout(() => setCopiedJobId((c) => (c === id ? null : c)), 2000);
    } catch {
      setError("Could not copy job id (clipboard blocked or unavailable).");
    }
  }

  async function deleteCrawlJobRecord(id: string, seedUrlForConfirm: string) {
    const ok = window.confirm(
      `Delete this crawl job?\n\n${seedUrlForConfirm}\n\nThis removes its queue rows, page audits, and fetch records from the database. You cannot undo this.`,
    );
    if (!ok) return;
    setJobDeleteBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/crawl-jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `Delete failed (${res.status}).`);
        return;
      }
      setJobsList((prev) => prev.filter((j) => j.id !== id));
      if (compareJobA === id) setCompareJobA("");
      if (compareJobB === id) setCompareJobB("");
      if (jobId === id) {
        setJobId(null);
        setUrls([]);
        setUrlsNextCursor(null);
        setStatus(null);
        setReportSummary(null);
        setUrlTableFilter("");
      }
    } catch (e) {
      setError(describeFetchFailure(e, "Delete crawl job"));
    } finally {
      setJobDeleteBusy(null);
    }
  }

  function toggleSelectAllFiltered() {
    const ids = filteredJobsDirectory.map((j) => j.id);
    if (ids.length === 0) return;
    setSelectedJobIds((prev) => {
      const every = ids.every((id) => prev.includes(id));
      if (every) return prev.filter((id) => !ids.includes(id));
      return [...new Set([...prev, ...ids])];
    });
  }

  async function deleteSelectedCrawlJobs() {
    if (selectedJobIds.length === 0) return;
    const ok = window.confirm(
      `Delete ${selectedJobIds.length} selected crawl job(s)?\n\nThis removes their queue rows, page audits, and fetch records. You cannot undo this.`,
    );
    if (!ok) return;
    const ids = [...selectedJobIds];
    setJobDeleteBusy("__batch__");
    setError(null);
    try {
      const res = await fetch("/api/v1/crawl-jobs/delete-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `Batch delete failed (${res.status}).`);
        return;
      }
      const json = (await res.json()) as { deleted: number; requested: number };
      if (json.deleted === 0) {
        setError("No matching crawl jobs were deleted.");
        return;
      }
      const removed = new Set(ids);
      setJobsList((prev) => prev.filter((j) => !removed.has(j.id)));
      if (compareJobA && removed.has(compareJobA)) setCompareJobA("");
      if (compareJobB && removed.has(compareJobB)) setCompareJobB("");
      if (jobId && removed.has(jobId)) {
        setJobId(null);
        setUrls([]);
        setUrlsNextCursor(null);
        setStatus(null);
        setReportSummary(null);
        setUrlTableFilter("");
      }
      setSelectedJobIds([]);
      if (json.deleted < json.requested) {
        setError(`Only ${json.deleted} of ${json.requested} jobs were removed (some ids were not found).`);
      }
    } catch (e) {
      setError(describeFetchFailure(e, "Batch delete crawl jobs"));
    } finally {
      setJobDeleteBusy(null);
    }
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
                <div className="inline-flex max-w-full items-center rounded-md border border-zinc-300 bg-zinc-100 px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wide text-zinc-900 whitespace-nowrap">
                  job: {jobId}
                </div>
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  <button
                    className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 hover:bg-zinc-50"
                    onClick={() => void copyJobId(jobId)}
                    type="button"
                  >
                    {copiedJobId === jobId ? "Copied" : "Copy ID"}
                  </button>
                  <button
                    className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 hover:bg-zinc-50"
                    onClick={() => refresh()}
                    disabled={refreshing}
                    type="button"
                  >
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
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

        <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium">Phase 2 — Compare crawls</div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => void loadJobListForCompare()}
                disabled={jobsListLoading}
                type="button"
              >
                {jobsListLoading ? "Loading…" : "Reload job list"}
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => clearCompareSelections()}
                disabled={!compareJobA && !compareJobB}
                type="button"
              >
                Clear A &amp; B
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Baseline <span className="font-mono">a</span> is usually the earlier crawl; <span className="font-mono">b</span> the later. URLs are matched by
            crawl URL hash. Rows: <span className="font-mono">new_in_b</span>, <span className="font-mono">removed_in_a</span>,{" "}
            <span className="font-mono">changed</span> (status, title, canonical, meta, word count, H1, content-type, robots meta, meta refresh, body
            hash, X-Robots-Tag, HTML <span className="font-mono">lang</span>, response time). With two jobs selected, this page updates the URL with{" "}
            <span className="font-mono">compareA</span> / <span className="font-mono">compareB</span> so you can bookmark or share the pair.
          </p>
          {searchingOlderJobsForUrlCompare ? (
            <div className="mt-2 text-xs text-zinc-500">
              Searching older jobs to resolve URL compare pair…
            </div>
          ) : null}
          {compareUrlHydrationNotice ? (
            <div className="mt-2 text-xs text-amber-700">{compareUrlHydrationNotice}</div>
          ) : null}
          {jobsListError ? <div className="mt-2 text-sm text-red-600">{jobsListError}</div> : null}
          {!jobsListError && !jobsListLoading && jobsList.length === 0 ? (
            <div className="mt-2 text-xs text-zinc-500">No crawl jobs returned. Start a crawl above, or check the database connection.</div>
          ) : null}
          {jobsList.length > 0 ? (
            <div className="mt-4">
              <label className="block text-xs font-medium text-zinc-700">
                Filter jobs
                <input
                  className="mt-1 w-full max-w-xl rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900/10"
                  value={jobDirectoryFilter}
                  onChange={(e) => setJobDirectoryFilter(e.target.value)}
                  placeholder="URL, status, job id, date…"
                  type="search"
                />
              </label>
              {jobDirectoryFilter.trim() !== "" ? (
                <p className="mt-1 text-xs text-zinc-500">
                  Showing {filteredJobsDirectory.length} of {jobsList.length} jobs (compare + past list).
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-medium text-zinc-700">
              Baseline crawl (A)
              <select
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                value={compareJobA}
                onChange={(e) => setCompareJobA(e.target.value)}
              >
                <option value="">Select job…</option>
                {comparePickOptionsA.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.seedUrl} — {j.status} ({new Date(j.createdAt).toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-zinc-700">
              Compare crawl (B)
              <select
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                value={compareJobB}
                onChange={(e) => setCompareJobB(e.target.value)}
              >
                <option value="">Select job…</option>
                {comparePickOptionsB.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.seedUrl} — {j.status} ({new Date(j.createdAt).toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {compareDiffPreview && (compareDiffPreview.loading || compareDiffPreview.counts) ? (
            <div className="mt-3 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              {compareDiffPreview.loading ? (
                <span className="text-zinc-500">Computing diff…</span>
              ) : compareDiffPreview.counts ? (
                <>
                  <span className="font-medium">Crawl size:</span> A has {compareDiffPreview.counts.pages_in_a} audited URLs, B has{" "}
                  {compareDiffPreview.counts.pages_in_b}.{" "}
                  <span className="font-medium">Diff summary:</span> {compareDiffPreview.counts.new_in_b} new in B,{" "}
                  {compareDiffPreview.counts.removed_in_a} removed since A, {compareDiffPreview.counts.changed} changed on same URLs.
                </>
              ) : null}
            </div>
          ) : null}
          {compareDiffPreview && !compareDiffPreview.loading && compareDiffPreview.rows ? (
            <div className="mt-4 rounded-lg border border-zinc-100">
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2">
                <span className="text-xs text-zinc-500">Quick presets:</span>
                {([
                  ["all", "All"],
                  ["status", "Status"],
                  ["content", "Content"],
                  ["technical", "Technical"],
                  ["performance", "Performance"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => applyComparePreset(id)}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      comparePreset === id
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2">
                <span className="text-xs text-zinc-500">One-click include new/removed:</span>
                {([
                  ["status", "Status + N/R"],
                  ["content", "Content + N/R"],
                  ["technical", "Technical + N/R"],
                  ["performance", "Performance + N/R"],
                ] as const).map(([id, label]) => (
                  <button
                    key={`${id}-nr`}
                    type="button"
                    onClick={() => applyComparePreset(id, true)}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      comparePreset === id && comparePresetIncludeNewRemoved
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="border-b border-zinc-100 px-3 py-2 text-[11px] text-zinc-500">
                Presets show <span className="font-mono">changed</span> rows where <span className="font-medium">any</span> of the preset’s fields
                appears in <span className="font-mono">changed_fields</span> (new/removed URLs stay hidden until you pick{" "}
                <span className="font-mono">All</span> preset, <span className="font-mono">All change kinds</span>, or enable{" "}
                <span className="font-mono">Include new/removed</span>).
              </p>
              {compareFieldAnyOf && compareFieldAnyOf.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-600">
                  <div>
                    <span className="font-medium">Preset fields (any of):</span>{" "}
                    <span className="font-mono">{compareFieldAnyOf.join(", ")}</span>
                  </div>
                  <label className="inline-flex items-center gap-1 text-xs text-zinc-700">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-zinc-300"
                      checked={comparePresetIncludeNewRemoved}
                      onChange={(e) => {
                        setComparePresetIncludeNewRemoved(e.target.checked);
                      }}
                    />
                    Include new/removed
                  </label>
                </div>
              ) : null}
              {(compareTableFilterKind !== "all" ||
                compareFieldFilter !== "all" ||
                compareTableFilterText.trim() !== "" ||
                compareOnlyStatusChanges ||
                comparePreset !== "all" ||
                comparePresetIncludeNewRemoved ||
                compareSortKey !== "kind" ||
                compareSortDir !== "asc" ||
                compareTablePageSize !== 200 ||
                compareTablePage > 1 ||
                !compareExpandOnlyChangedFields) ? (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-100 px-3 py-2 text-[11px] text-zinc-600">
                  <span className="mr-1 text-zinc-500">Active:</span>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-50"
                    onClick={() => clearCompareActiveFilters()}
                  >
                    Clear filters
                  </button>
                  {compareTableFilterKind !== "all" ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareTableFilterKind("all")}
                    >
                      kind={compareTableFilterKind} ×
                    </button>
                  ) : null}
                  {compareFieldFilter !== "all" ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareFieldFilter("all")}
                    >
                      field={compareFieldFilter} ×
                    </button>
                  ) : null}
                  {compareTableFilterText.trim() !== "" ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareTableFilterText("")}
                    >
                      q={compareTableFilterText.trim()} ×
                    </button>
                  ) : null}
                  {compareOnlyStatusChanges ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareOnlyStatusChanges(false)}
                    >
                      status-only ×
                    </button>
                  ) : null}
                  {comparePreset !== "all" ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setComparePreset("all")}
                    >
                      preset={comparePreset} ×
                    </button>
                  ) : null}
                  {comparePresetIncludeNewRemoved ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setComparePresetIncludeNewRemoved(false)}
                    >
                      include N/R ×
                    </button>
                  ) : null}
                  {compareSortKey !== "kind" || compareSortDir !== "asc" ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => {
                        setCompareSortKey("kind");
                        setCompareSortDir("asc");
                      }}
                    >
                      sort={compareSortKey}:{compareSortDir} ×
                    </button>
                  ) : null}
                  {compareTablePageSize !== 200 ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareTablePageSize(200)}
                    >
                      page size={compareTablePageSize} ×
                    </button>
                  ) : null}
                  {compareTablePage > 1 ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareTablePage(1)}
                    >
                      page={compareTablePage} ×
                    </button>
                  ) : null}
                  {!compareExpandOnlyChangedFields ? (
                    <button
                      type="button"
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 hover:bg-zinc-100"
                      onClick={() => setCompareExpandOnlyChangedFields(true)}
                    >
                      expanded=all fields ×
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2">
                <select
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                  value={compareTableFilterKind}
                  onChange={(e) => {
                    setComparePreset("all");
                    setCompareFieldAnyOf(null);
                    setCompareTableFilterKind(e.target.value as "all" | CompareChangeKind);
                  }}
                >
                  <option value="all">All change kinds</option>
                  <option value="changed">changed</option>
                  <option value="new_in_b">new_in_b</option>
                  <option value="removed_in_a">removed_in_a</option>
                </select>
                <input
                  className="min-w-[14rem] flex-1 rounded-md border border-zinc-200 px-2 py-1 text-xs"
                  value={compareTableFilterText}
                  onChange={(e) => {
                    setComparePreset("all");
                    setCompareFieldAnyOf(null);
                    setCompareTableFilterText(e.target.value);
                  }}
                  placeholder="Filter diff rows by URL/title/status/fields…"
                  type="search"
                />
                <select
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                  value={compareFieldFilter}
                  onChange={(e) => {
                    setComparePreset("all");
                    setCompareFieldAnyOf(null);
                    setCompareFieldFilter(e.target.value as "all" | CompareChangedField);
                  }}
                >
                  <option value="all">All fields</option>
                  <option value="status">status</option>
                  <option value="title">title</option>
                  <option value="canonical">canonical</option>
                  <option value="meta_description">meta_description</option>
                  <option value="word_count">word_count</option>
                  <option value="h1_text">h1_text</option>
                  <option value="h1_count">h1_count</option>
                  <option value="content_type">content_type</option>
                  <option value="robots_meta">robots_meta</option>
                  <option value="meta_refresh">meta_refresh</option>
                  <option value="content_hash">content_hash</option>
                  <option value="x_robots_tag">x_robots_tag</option>
                  <option value="html_lang">html_lang</option>
                  <option value="response_time_ms">response_time_ms</option>
                </select>
                <label className="inline-flex items-center gap-1 text-xs text-zinc-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                    checked={compareOnlyStatusChanges}
                    onChange={(e) => {
                      setComparePreset("all");
                      setCompareFieldAnyOf(null);
                      setCompareOnlyStatusChanges(e.target.checked);
                    }}
                  />
                  Status changes only
                </label>
                <span className="text-xs text-zinc-500">{filteredCompareRows.length} row(s)</span>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    compareTableFilterKind === "changed"
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
                  }`}
                  onClick={() => toggleCompareKindQuickFilter("changed")}
                >
                  changed: {filteredCompareKindCounts.changed}
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    compareTableFilterKind === "new_in_b"
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
                  }`}
                  onClick={() => toggleCompareKindQuickFilter("new_in_b")}
                >
                  new_in_b: {filteredCompareKindCounts.newInB}
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    compareTableFilterKind === "removed_in_a"
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
                  }`}
                  onClick={() => toggleCompareKindQuickFilter("removed_in_a")}
                >
                  removed_in_a: {filteredCompareKindCounts.removedInA}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => expandAllVisibleCompareRows()}
                  disabled={visibleSortedCompareRows.length === 0}
                >
                  Expand visible
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => expandAllLoadedCompareRows()}
                  disabled={sortedFilteredCompareRows.length === 0}
                >
                  Expand all loaded
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => collapseAllVisibleCompareRows()}
                  disabled={visibleSortedCompareRows.length === 0}
                >
                  Collapse visible
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => collapseAllLoadedCompareRows()}
                  disabled={sortedFilteredCompareRows.length === 0}
                >
                  Collapse all loaded
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  onClick={() => resetCompareViewControls()}
                >
                  Reset view
                </button>
                <select
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                  value={compareDiffApiPageLimit}
                  onChange={(e) => setCompareDiffApiPageLimit(Number(e.target.value) as 200 | 500 | 1000)}
                >
                  <option value={200}>API page: 200</option>
                  <option value={500}>API page: 500</option>
                  <option value={1000}>API page: 1000</option>
                </select>
                <select
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                  value={compareTablePageSize}
                  onChange={(e) => setCompareTablePageSize(Number(e.target.value) as 100 | 200 | 500)}
                >
                  <option value={100}>100 / page</option>
                  <option value={200}>200 / page</option>
                  <option value={500}>500 / page</option>
                </select>
                <label className="inline-flex items-center gap-1 text-xs text-zinc-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                    checked={compareExpandOnlyChangedFields}
                    onChange={(e) => setCompareExpandOnlyChangedFields(e.target.checked)}
                  />
                  Expanded: changed fields only
                </label>
                <select
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                  value={compareSortKey}
                  onChange={(e) => setCompareSortKey(e.target.value as CompareSortKey)}
                >
                  <option value="kind">Sort: kind</option>
                  <option value="url">Sort: URL</option>
                  <option value="fields">Sort: changed fields</option>
                  <option value="status_a">Sort: status A</option>
                  <option value="status_b">Sort: status B</option>
                </select>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  onClick={() => setCompareSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                >
                  {compareSortDir === "asc" ? "Asc" : "Desc"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => downloadFilteredComparePreviewCsv()}
                  disabled={filteredCompareRows.length === 0}
                >
                  Download filtered preview CSV
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => downloadFilteredCompareFullCsv()}
                  disabled={filteredCompareRows.length === 0}
                >
                  Download filtered full CSV
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => downloadVisibleComparePageCsv()}
                  disabled={visibleSortedCompareRows.length === 0}
                >
                  Download current page CSV
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => autoLoadAllAndExportFilteredCsv()}
                  disabled={!compareJobA || !compareJobB || compareJobA === compareJobB || compareDiffPreview.loading}
                >
                  {compareExportAfterAutoLoad ? "Auto-load + export pending…" : "Auto-load all + export filtered CSV"}
                </button>
                {(compareAutoLoadAll || compareExportAfterAutoLoad) && (
                  <button
                    type="button"
                    className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                    onClick={() => cancelAutoLoadExportWorkflow()}
                  >
                    Cancel auto-load/export
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2 text-[11px] text-zinc-600">
                {compareDiffPreview.totalDiffRows != null ? (
                  <span>
                    Loaded {compareDiffPreview.rows?.length ?? 0} of {compareDiffPreview.totalDiffRows} diff rows (into this
                    view).
                  </span>
                ) : null}
                {compareDiffPreview.nextCursor ? (
                  <span className="text-zinc-500">
                    Approx remaining: {compareRemainingRows} row(s), {compareEstimatedRemainingPages} page(s) at{" "}
                    {compareDiffApiPageLimit}/page.
                  </span>
                ) : null}
                {compareAutoLoadAll ? <span className="text-zinc-700">Auto-load in progress…</span> : null}
                {compareDiffPreview.nextCursor ? (
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => void loadMoreCompareDiffs()}
                    disabled={compareDiffPreview.loadingMore}
                  >
                    {compareDiffPreview.loadingMore ? "Loading…" : "Load more diffs"}
                  </button>
                ) : compareDiffPreview.totalDiffRows != null &&
                  (compareDiffPreview.rows?.length ?? 0) > 0 &&
                  (compareDiffPreview.rows?.length ?? 0) >= compareDiffPreview.totalDiffRows ? (
                  <span className="text-zinc-500">All diff rows loaded.</span>
                ) : null}
                {compareDiffPreview.nextCursor ? (
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => setCompareAutoLoadAll((v) => !v)}
                    disabled={compareDiffPreview.loadingMore}
                  >
                    {compareAutoLoadAll ? "Stop auto-load" : "Auto-load all"}
                  </button>
                ) : null}
                <span className="text-zinc-500">
                  Filtered CSV exports only include rows loaded here; use <span className="font-medium">Download compare CSV</span>{" "}
                  for the complete diff.
                </span>
              </div>
              {compareDiffPreview.totalDiffRows != null && compareDiffPreview.totalDiffRows > 0 ? (
                <div className="border-b border-zinc-100 px-3 py-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span>Diff load progress</span>
                    <span>
                      {Math.min(
                        100,
                        Math.round(((compareDiffPreview.rows?.length ?? 0) / compareDiffPreview.totalDiffRows) * 100),
                      )}
                      %
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-100">
                    <div
                      className="h-full bg-zinc-700 transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(
                            0,
                            Math.round(((compareDiffPreview.rows?.length ?? 0) / compareDiffPreview.totalDiffRows) * 100),
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {compareLoadMoreError ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-xs text-red-600">
                  <span>{compareLoadMoreError}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                      onClick={() => void loadMoreCompareDiffs()}
                      disabled={compareDiffPreview.loadingMore || !compareDiffPreview.nextCursor}
                    >
                      Retry page
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                      onClick={() => retryAutoLoadFromHere()}
                      disabled={compareDiffPreview.loadingMore || !compareDiffPreview.nextCursor}
                    >
                      Retry auto-load
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="max-h-64 overflow-auto">
                {filteredCompareRows.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-zinc-500">No compare rows match the current filters.</div>
                ) : (
                  <p className="border-b border-zinc-50 px-3 py-1 text-[11px] text-zinc-500">
                    Click a row to expand full A vs B field values. Differing values are emphasized.
                  </p>
                )}
                {filteredCompareRows.length === 0 ? null : (
                  <table className="min-w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-zinc-50 text-zinc-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-zinc-700"
                            onClick={() => setCompareSortFromHeader("kind")}
                          >
                            Kind {compareSortKey === "kind" ? (compareSortDir === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                        <th className="px-3 py-2 font-medium">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-zinc-700"
                            onClick={() => setCompareSortFromHeader("url")}
                          >
                            URL {compareSortKey === "url" ? (compareSortDir === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                        <th className="px-3 py-2 font-medium">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-zinc-700"
                            onClick={() => setCompareSortFromHeader("fields")}
                          >
                            Changed fields {compareSortKey === "fields" ? (compareSortDir === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                        <th className="px-3 py-2 font-medium">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 hover:text-zinc-700"
                              onClick={() => setCompareSortFromHeader("status_a")}
                            >
                              Status A {compareSortKey === "status_a" ? (compareSortDir === "asc" ? "↑" : "↓") : ""}
                            </button>
                            <span>/</span>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 hover:text-zinc-700"
                              onClick={() => setCompareSortFromHeader("status_b")}
                            >
                              B {compareSortKey === "status_b" ? (compareSortDir === "asc" ? "↑" : "↓") : ""}
                            </button>
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {visibleSortedCompareRows.map((r, i) => {
                        const rowKey = `${r.change_kind}\t${r.url}`;
                        const open = expandedCompareRowKeys.has(rowKey);
                        return (
                          <Fragment key={`${r.change_kind}:${r.url}:${i}`}>
                            <tr
                              className="cursor-pointer hover:bg-zinc-50/70"
                              onClick={() => toggleCompareRowExpanded(rowKey)}
                            >
                              <td className="px-3 py-2 font-mono">
                                <span className="mr-1 inline-block w-3 text-zinc-400">{open ? "▼" : "▶"}</span>
                                {r.change_kind}
                              </td>
                              <td className="max-w-[38rem] truncate px-3 py-2 font-mono">{r.url}</td>
                              <td className="px-3 py-2">
                                {r.changed_fields ? (
                                  <div className="flex flex-wrap gap-1">
                                    {r.changed_fields
                                      .split("|")
                                      .map((f) => f.trim())
                                      .filter(Boolean)
                                      .map((f) => (
                                        <button
                                          key={`${r.url}:${f}`}
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            quickFilterByChangedField(f as CompareChangedField);
                                          }}
                                          className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700"
                                        >
                                          {f}
                                        </button>
                                      ))}
                                  </div>
                                ) : (
                                  "-"
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {String(r.http_status_a || "-")} / {String(r.http_status_b || "-")}
                              </td>
                            </tr>
                            {open ? (
                              <tr className="bg-zinc-50/80">
                                <td colSpan={4} className="px-3 py-3">
                                  <div className="grid max-w-6xl gap-x-4 gap-y-1 text-[11px] md:grid-cols-[minmax(7rem,9rem)_1fr_1fr]">
                                    <div className="border-b border-zinc-200 pb-1 font-semibold text-zinc-600">Field</div>
                                    <div className="border-b border-zinc-200 pb-1 font-mono font-semibold text-zinc-600">
                                      A (baseline)
                                    </div>
                                    <div className="border-b border-zinc-200 pb-1 font-mono font-semibold text-zinc-600">
                                      B (compare)
                                    </div>
                                    {COMPARE_EXPAND_FIELD_PAIRS.map((p) => {
                                      const va = r.fullRow[p.a];
                                      const vb = r.fullRow[p.b];
                                      const diff = va !== vb;
                                      if (compareExpandOnlyChangedFields && !diff) return null;
                                      return (
                                        <Fragment key={p.label}>
                                          <div className={`py-0.5 font-medium ${diff ? "text-zinc-900" : "text-zinc-500"}`}>
                                            {p.label}
                                          </div>
                                          <div
                                            className={`break-words py-0.5 font-mono ${diff ? "text-zinc-900" : "text-zinc-600"}`}
                                          >
                                            {va === "" ? "—" : va}
                                          </div>
                                          <div
                                            className={`break-words py-0.5 font-mono ${diff ? "text-zinc-900" : "text-zinc-600"}`}
                                          >
                                            {vb === "" ? "—" : vb}
                                          </div>
                                        </Fragment>
                                      );
                                    })}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                <div>
                  Page {compareTablePage} of {compareTableTotalPages}. Showing {visibleSortedCompareRows.length} of{" "}
                  {sortedFilteredCompareRows.length} filtered row(s).
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => setCompareTablePage(1)}
                    disabled={compareTablePage <= 1}
                  >
                    First
                  </button>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-500">Go to</span>
                    <input
                      className="w-14 rounded border border-zinc-200 px-1.5 py-1 text-xs text-zinc-700"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={comparePageJumpInput}
                      onChange={(e) => setComparePageJumpInput(e.target.value.replace(/[^0-9]/g, ""))}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        goToComparePageFromInput();
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => goToComparePageFromInput()}
                    disabled={sortedFilteredCompareRows.length === 0}
                  >
                    Go
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => setCompareTablePage((p) => Math.max(1, p - 1))}
                    disabled={compareTablePage <= 1}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => setCompareTablePage((p) => Math.min(compareTableTotalPages, p + 1))}
                    disabled={compareTablePage >= compareTableTotalPages}
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    onClick={() => setCompareTablePage(compareTableTotalPages)}
                    disabled={compareTablePage >= compareTableTotalPages}
                  >
                    Last
                  </button>
                </div>
              </div>
              {sortedFilteredCompareRows.length > compareTablePageSize ? (
                <div className="border-t border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                  Tip: use sort + filters to focus priority rows, then page through remaining results.
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              onClick={() => downloadCompareCsv()}
              disabled={!compareJobA || !compareJobB || compareJobA === compareJobB}
              type="button"
            >
              Download compare CSV
            </button>
            <button
              className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => void downloadCompareJson()}
              disabled={!compareJobA || !compareJobB || compareJobA === compareJobB}
              type="button"
            >
              Download compare JSON
            </button>
            <button
              className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => void copyCompareDeepLink()}
              disabled={!compareJobA || !compareJobB || compareJobA === compareJobB}
              type="button"
            >
              {compareLinkCopied ? "Link copied" : "Copy compare link"}
            </button>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium">Past crawl jobs</div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => void loadJobListForCompare()}
                disabled={jobsListLoading}
                type="button"
              >
                {jobsListLoading ? "Loading…" : "Reload list"}
              </button>
              <button
                className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                onClick={() => void deleteSelectedCrawlJobs()}
                disabled={jobDeleteBusy !== null || jobsListLoading || selectedJobIds.length === 0}
                type="button"
              >
                {jobDeleteBusy === "__batch__" ? "Deleting…" : `Delete selected (${selectedJobIds.length})`}
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Remove individual jobs from the database (queue, audits, fetches for that job). Use{" "}
            <span className="font-medium">Filter jobs</span> in Phase 2 to narrow this list and the compare dropdowns. <span className="font-medium">View</span>{" "}
            loads that job into Status, reports, and Discovered URLs above.
          </p>
          <div className="mt-3 flex max-w-2xl flex-col gap-2 sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1 text-xs font-medium text-zinc-700">
              Open job by ID
              <input
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-zinc-900/10"
                value={openJobByIdInput}
                onChange={(e) => setOpenJobByIdInput(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                disabled={jobDeleteBusy !== null}
                onKeyDown={(e) => e.key === "Enter" && void openJobByPastedId()}
              />
            </label>
            <button
              className="h-10 shrink-0 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
              type="button"
              disabled={jobDeleteBusy !== null || jobsListLoading}
              onClick={() => void openJobByPastedId()}
            >
              Load job
            </button>
          </div>
          {jobsListError ? <div className="mt-2 text-sm text-red-600">{jobsListError}</div> : null}
          {jobsList.length > 0 && filteredJobsDirectory.length > 0 ? (
            <div className="mt-2">
              <button
                className="text-xs text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 disabled:opacity-50"
                type="button"
                disabled={jobDeleteBusy !== null || jobsListLoading}
                onClick={() => toggleSelectAllFiltered()}
              >
                {allFilteredJobsSelected
                  ? "Clear selection for jobs shown below"
                  : `Select all jobs shown below (${filteredJobsDirectory.length})`}
              </button>
            </div>
          ) : null}
          <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-zinc-100">
            {jobsList.length === 0 ? (
              <div className="px-4 py-6 text-sm text-zinc-500">
                {jobsListLoading ? "Loading jobs…" : "No jobs loaded. Use Reload list or start a crawl."}
              </div>
            ) : filteredJobsDirectory.length === 0 ? (
              <div className="px-4 py-6 text-sm text-zinc-500">No jobs match the filter.</div>
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {filteredJobsDirectory.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      <input
                        className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                        type="checkbox"
                        checked={selectedJobIds.includes(j.id)}
                        disabled={jobDeleteBusy !== null}
                        onChange={(e) =>
                          setSelectedJobIds((prev) =>
                            e.target.checked ? [...prev, j.id] : prev.filter((x) => x !== j.id),
                          )
                        }
                        aria-label={`Select job ${j.id}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs text-zinc-800">{j.seedUrl}</div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {j.status} · {new Date(j.createdAt).toLocaleString()} ·{" "}
                          <span className="font-mono text-[10px] text-zinc-400">{j.id.slice(0, 8)}…</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1">
                      <button
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                        type="button"
                        disabled={jobsListLoading || jobDeleteBusy !== null}
                        onClick={() => void openJobInViewer(j.id)}
                      >
                        View
                      </button>
                      <button
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                        type="button"
                        disabled={jobDeleteBusy !== null}
                        onClick={() => void copyJobId(j.id)}
                      >
                        {copiedJobId === j.id ? "Copied" : "Copy ID"}
                      </button>
                      <button
                        className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                        type="button"
                        disabled={jobDeleteBusy !== null}
                        onClick={() => void deleteCrawlJobRecord(j.id, j.seedUrl)}
                      >
                        {jobDeleteBusy === j.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {jobsListNextCursor ? (
            <div className="mt-3">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => void loadMoreJobsForCompare()}
                disabled={jobsListLoading || jobsListLoadingMore || jobDeleteBusy !== null}
                type="button"
              >
                {jobsListLoadingMore ? "Loading…" : "Load older jobs"}
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-8 rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-100 px-6 py-4">
            <div className="text-sm font-medium">Phase 1 Reports</div>
            <p className="mt-1 text-xs text-zinc-500">
              {REPORT_BUTTONS.length + 1} downloads (CSV exports + sitemap).
            </p>
            <button
              className="mt-3 inline-flex h-10 w-full max-w-md items-center justify-center rounded-lg border-2 border-zinc-900 bg-white text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => void downloadAllReportsZip()}
              disabled={!jobId || bulkZipBusy || urls.length === 0}
              type="button"
            >
              {bulkZipBusy ? (bulkZipProgress ?? "Working…") : "Download all CSV + XML (ZIP)"}
            </button>
            <p className="mt-1 text-xs text-zinc-500">
              One ZIP: <span className="font-mono">csv/</span> ({REPORT_BUTTONS.length} files),{" "}
              <span className="font-mono">xml/sitemap.xml</span>, and{" "}
              <span className="font-mono">json/summary.json</span>. May take a minute on large jobs.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {REPORT_BUTTONS.map((report) => (
                <button
                  key={report.id}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-left text-xs hover:bg-zinc-50 disabled:opacity-50"
                  onClick={() => exportReport(report.id, "csv")}
                  disabled={!jobId}
                  type="button"
                >
                  {report.label}
                </button>
              ))}
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-left text-xs hover:bg-zinc-50 disabled:opacity-50"
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
          <div className="flex flex-col gap-3 border-b border-zinc-100 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-medium">Discovered URLs</div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <input
                className="w-full min-w-[12rem] rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900/10 sm:max-w-md"
                value={urlTableFilter}
                onChange={(e) => setUrlTableFilter(e.target.value)}
                placeholder="Filter by URL, title, status, queue…"
                disabled={!jobId || urls.length === 0}
                type="search"
                aria-label="Filter discovered URLs"
              />
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => loadUrls()}
                disabled={!jobId}
                type="button"
              >
                Reload
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => void loadMoreUrls()}
                disabled={!jobId || !urlsNextCursor || urlsLoadingMore}
                type="button"
              >
                {urlsLoadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          </div>
          {urls.length > 0 ? (
            <div className="border-b border-zinc-50 px-6 py-2 text-xs text-zinc-500">
              {urlTableFilter.trim() !== "" ? (
                <>
                  Showing {filteredUrls.length} of {urls.length} loaded
                  {reportSummary ? <> (job total {reportSummary.urls} URLs)</> : null}
                </>
              ) : (
                <>
                  Showing {urls.length} URL{urls.length === 1 ? "" : "s"} loaded
                  {reportSummary ? <> of {reportSummary.urls} in this job</> : null}
                  {urlsNextCursor ? <> — more available below.</> : null}
                </>
              )}
            </div>
          ) : null}
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
                ) : filteredUrls.length === 0 ? (
                  <tr>
                    <td className="px-6 py-6 text-zinc-500" colSpan={5}>
                      No URLs match your filter.
                    </td>
                  </tr>
                ) : (
                  filteredUrls.map((u) => (
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


