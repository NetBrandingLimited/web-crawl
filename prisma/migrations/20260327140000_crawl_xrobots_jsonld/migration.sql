-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "xRobotsTag" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "jsonLdCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "jsonLdTypesSummary" VARCHAR(1024);
