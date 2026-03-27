-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "amphtmlUrl" VARCHAR(2048);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "rssFeedUrl" VARCHAR(2048);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "atomFeedUrl" VARCHAR(2048);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "jsonFeedUrl" VARCHAR(2048);
