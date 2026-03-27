-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "linksExternalCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "responseTimeMs" INTEGER;
