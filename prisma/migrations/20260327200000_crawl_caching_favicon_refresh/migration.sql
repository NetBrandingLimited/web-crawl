-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "cacheControlHeader" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "lastModifiedHeader" VARCHAR(128);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "etagHeader" VARCHAR(256);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "faviconUrl" VARCHAR(2048);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "metaRefreshContent" VARCHAR(512);
