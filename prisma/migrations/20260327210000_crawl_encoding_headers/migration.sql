-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "contentEncodingHeader" VARCHAR(128);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "varyHeader" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "contentLanguageHeader" VARCHAR(128);
