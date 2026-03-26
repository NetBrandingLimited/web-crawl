-- CreateTable
CREATE TABLE "CrawlPageAudit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "urlHash" CHAR(40) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "depth" INTEGER NOT NULL,
    "httpStatus" INTEGER,
    "contentType" VARCHAR(255),
    "title" TEXT,
    "titleLength" INTEGER,
    "metaDesc" TEXT,
    "metaDescLength" INTEGER,
    "h1Count" INTEGER NOT NULL DEFAULT 0,
    "h2Count" INTEGER NOT NULL DEFAULT 0,
    "canonicalUrl" VARCHAR(2048),
    "robotsMeta" VARCHAR(512),
    "hreflangCount" INTEGER NOT NULL DEFAULT 0,
    "linksOutCount" INTEGER NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" CHAR(40),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchError" VARCHAR(512),

    CONSTRAINT "CrawlPageAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrawlPageAudit_jobId_urlHash_key" ON "CrawlPageAudit"("jobId", "urlHash");

-- CreateIndex
CREATE INDEX "CrawlPageAudit_jobId_httpStatus_idx" ON "CrawlPageAudit"("jobId", "httpStatus");

-- AddForeignKey
ALTER TABLE "CrawlPageAudit" ADD CONSTRAINT "CrawlPageAudit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrawlJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
