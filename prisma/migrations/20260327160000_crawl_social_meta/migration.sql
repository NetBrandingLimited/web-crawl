-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "ogTitle" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "ogDescription" TEXT;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "ogImage" VARCHAR(2048);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "twitterCard" VARCHAR(64);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "twitterTitle" VARCHAR(512);
