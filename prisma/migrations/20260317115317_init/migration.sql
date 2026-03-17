-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "hostname" VARCHAR(255) NOT NULL,
    "scheme" VARCHAR(10) NOT NULL,
    "obeyRobots" BOOLEAN NOT NULL DEFAULT true,
    "crawlDelayMs" INTEGER,
    "robotsTxtEtag" VARCHAR(128),
    "robotsFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlJob" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "seedUrl" VARCHAR(2048) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "maxDepth" INTEGER NOT NULL DEFAULT 3,
    "maxPages" INTEGER NOT NULL DEFAULT 5000,
    "maxDurationSeconds" INTEGER NOT NULL DEFAULT 3600,
    "rateLimitRpsPerHost" DECIMAL(6,3) NOT NULL DEFAULT 2.0,
    "maxConcurrencyPerHost" INTEGER NOT NULL DEFAULT 2,
    "userAgent" VARCHAR(255) NOT NULL,
    "obeyRobots" BOOLEAN NOT NULL DEFAULT true,
    "includeSubdomains" BOOLEAN NOT NULL DEFAULT false,
    "sameSiteOnly" BOOLEAN NOT NULL DEFAULT true,
    "followRedirects" BOOLEAN NOT NULL DEFAULT true,
    "respectNofollow" BOOLEAN NOT NULL DEFAULT true,
    "stripTracking" BOOLEAN NOT NULL DEFAULT true,
    "allowedPathPatterns" TEXT,
    "blockedPathPatterns" TEXT,
    "parseContentTypes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CrawlJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sitemap" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "discoveredAt" TIMESTAMP(3),
    "lastFetchedAt" TIMESTAMP(3),
    "statusCode" INTEGER,
    "compressed" BOOLEAN,

    CONSTRAINT "Sitemap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RobotsTxt" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "body" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "statusCode" INTEGER,
    "sitemapsExtracted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RobotsTxt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Url" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "urlHash" CHAR(40) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "canonicalUrlHash" CHAR(40),
    "redirectFinalUrlHash" CHAR(40),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCrawlAt" TIMESTAMP(3),
    "isCanonical" BOOLEAN NOT NULL DEFAULT false,
    "robotsAllowed" BOOLEAN,
    "httpStatus" INTEGER,
    "contentType" VARCHAR(255),
    "contentLength" BIGINT,
    "checksumSha256" CHAR(64),

    CONSTRAINT "Url_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlQueue" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "urlHash" CHAR(40) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "depth" INTEGER NOT NULL,
    "discoveredFromUrlHash" CHAR(40),
    "state" VARCHAR(16) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enqueueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3),
    "lastError" VARCHAR(512),

    CONSTRAINT "CrawlQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UrlFetch" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "urlId" TEXT NOT NULL,
    "requestedUrl" VARCHAR(2048) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL,
    "httpStatus" INTEGER,
    "contentType" VARCHAR(255),
    "contentLength" BIGINT,
    "redirectChain" TEXT,
    "redirectHops" INTEGER,
    "canonicalFromHeader" VARCHAR(2048),
    "canonicalFromHtml" VARCHAR(2048),
    "errorMessage" VARCHAR(512),
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UrlFetch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redirect" (
    "id" TEXT NOT NULL,
    "fetchId" TEXT NOT NULL,
    "hopOrder" INTEGER NOT NULL,
    "fromUrl" VARCHAR(2048) NOT NULL,
    "toUrl" VARCHAR(2048) NOT NULL,
    "statusCode" INTEGER NOT NULL,

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HttpHeader" (
    "id" TEXT NOT NULL,
    "fetchId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "HttpHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "rps" DECIMAL(6,3) NOT NULL,
    "burst" INTEGER NOT NULL,
    "lastRequestAt" TIMESTAMP(3),

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandSet" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandVariant" (
    "id" TEXT NOT NULL,
    "brandSetId" TEXT NOT NULL,
    "variantText" VARCHAR(512) NOT NULL,
    "variantType" VARCHAR(32) NOT NULL,
    "domain" VARCHAR(255),
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiQuery" (
    "id" TEXT NOT NULL,
    "keyword" VARCHAR(512) NOT NULL,
    "localeGl" VARCHAR(8),
    "localeHl" VARCHAR(8),
    "localeCr" VARCHAR(8),
    "brandSetId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL,
    "error" TEXT,
    "quotaSnapshot" JSONB,
    "requesterUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "hasAiAnswer" BOOLEAN NOT NULL,
    "visibilityScore" INTEGER NOT NULL,
    "citationPositionBucket" VARCHAR(16) NOT NULL,
    "snapshotRef" VARCHAR(512),
    "snapshotMime" VARCHAR(64),
    "rawAnswer" TEXT,
    "answerLang" VARCHAR(16),
    "extractionMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMention" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "brandSetId" TEXT NOT NULL,
    "variantId" TEXT,
    "matchedText" VARCHAR(512) NOT NULL,
    "isCited" BOOLEAN NOT NULL,
    "snippet" TEXT,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCitation" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT,
    "domain" VARCHAR(255),
    "position" INTEGER NOT NULL,
    "isOurDomain" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCompetitorDomain" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "count" INTEGER NOT NULL,
    "isOurDomain" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCompetitorDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_scheme_key" ON "Domain"("hostname", "scheme");

-- CreateIndex
CREATE INDEX "CrawlJob_domainId_createdAt_idx" ON "CrawlJob"("domainId", "createdAt");

-- CreateIndex
CREATE INDEX "CrawlJob_status_createdAt_idx" ON "CrawlJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Sitemap_domainId_idx" ON "Sitemap"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "RobotsTxt_domainId_key" ON "RobotsTxt"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "Url_urlHash_key" ON "Url"("urlHash");

-- CreateIndex
CREATE INDEX "Url_domainId_idx" ON "Url"("domainId");

-- CreateIndex
CREATE INDEX "Url_domainId_httpStatus_idx" ON "Url"("domainId", "httpStatus");

-- CreateIndex
CREATE INDEX "CrawlQueue_jobId_state_availableAt_priority_idx" ON "CrawlQueue"("jobId", "state", "availableAt", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlQueue_jobId_urlHash_key" ON "CrawlQueue"("jobId", "urlHash");

-- CreateIndex
CREATE INDEX "UrlFetch_jobId_requestedAt_idx" ON "UrlFetch"("jobId", "requestedAt");

-- CreateIndex
CREATE INDEX "UrlFetch_urlId_requestedAt_idx" ON "UrlFetch"("urlId", "requestedAt");

-- CreateIndex
CREATE INDEX "Redirect_fetchId_hopOrder_idx" ON "Redirect"("fetchId", "hopOrder");

-- CreateIndex
CREATE INDEX "RateLimit_domainId_idx" ON "RateLimit"("domainId");

-- CreateIndex
CREATE INDEX "BrandVariant_brandSetId_idx" ON "BrandVariant"("brandSetId");

-- CreateIndex
CREATE INDEX "AiQuery_keyword_idx" ON "AiQuery"("keyword");

-- CreateIndex
CREATE UNIQUE INDEX "AiQuery_keyword_localeGl_localeHl_localeCr_brandSetId_key" ON "AiQuery"("keyword", "localeGl", "localeHl", "localeCr", "brandSetId");

-- CreateIndex
CREATE INDEX "AiRun_source_startedAt_idx" ON "AiRun"("source", "startedAt");

-- CreateIndex
CREATE INDEX "AiRun_status_idx" ON "AiRun"("status");

-- CreateIndex
CREATE INDEX "AiResult_queryId_createdAt_idx" ON "AiResult"("queryId", "createdAt");

-- CreateIndex
CREATE INDEX "AiResult_source_idx" ON "AiResult"("source");

-- CreateIndex
CREATE INDEX "AiResult_visibilityScore_idx" ON "AiResult"("visibilityScore");

-- CreateIndex
CREATE INDEX "AiMention_resultId_idx" ON "AiMention"("resultId");

-- CreateIndex
CREATE INDEX "AiMention_brandSetId_isCited_idx" ON "AiMention"("brandSetId", "isCited");

-- CreateIndex
CREATE INDEX "AiCitation_resultId_idx" ON "AiCitation"("resultId");

-- CreateIndex
CREATE INDEX "AiCitation_domain_resultId_idx" ON "AiCitation"("domain", "resultId");

-- CreateIndex
CREATE INDEX "AiCitation_isOurDomain_idx" ON "AiCitation"("isOurDomain");

-- CreateIndex
CREATE INDEX "AiCompetitorDomain_resultId_count_idx" ON "AiCompetitorDomain"("resultId", "count");

-- CreateIndex
CREATE UNIQUE INDEX "AiCompetitorDomain_resultId_domain_key" ON "AiCompetitorDomain"("resultId", "domain");

-- AddForeignKey
ALTER TABLE "CrawlJob" ADD CONSTRAINT "CrawlJob_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sitemap" ADD CONSTRAINT "Sitemap_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotsTxt" ADD CONSTRAINT "RobotsTxt_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Url" ADD CONSTRAINT "Url_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlQueue" ADD CONSTRAINT "CrawlQueue_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrawlJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UrlFetch" ADD CONSTRAINT "UrlFetch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrawlJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UrlFetch" ADD CONSTRAINT "UrlFetch_urlId_fkey" FOREIGN KEY ("urlId") REFERENCES "Url"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redirect" ADD CONSTRAINT "Redirect_fetchId_fkey" FOREIGN KEY ("fetchId") REFERENCES "UrlFetch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpHeader" ADD CONSTRAINT "HttpHeader_fetchId_fkey" FOREIGN KEY ("fetchId") REFERENCES "UrlFetch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateLimit" ADD CONSTRAINT "RateLimit_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandVariant" ADD CONSTRAINT "BrandVariant_brandSetId_fkey" FOREIGN KEY ("brandSetId") REFERENCES "BrandSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiQuery" ADD CONSTRAINT "AiQuery_brandSetId_fkey" FOREIGN KEY ("brandSetId") REFERENCES "BrandSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiResult" ADD CONSTRAINT "AiResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiResult" ADD CONSTRAINT "AiResult_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "AiQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMention" ADD CONSTRAINT "AiMention_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMention" ADD CONSTRAINT "AiMention_brandSetId_fkey" FOREIGN KEY ("brandSetId") REFERENCES "BrandSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMention" ADD CONSTRAINT "AiMention_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "BrandVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCitation" ADD CONSTRAINT "AiCitation_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCompetitorDomain" ADD CONSTRAINT "AiCompetitorDomain_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "AiResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
