-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "linksMailtoCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "linksTelCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "linksHashOnlyCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "paginationNextUrl" VARCHAR(2048);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "paginationPrevUrl" VARCHAR(2048);
