-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "h1Text" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "htmlLang" VARCHAR(64);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "viewportMeta" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "charsetMeta" VARCHAR(64);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "linksNofollowCount" INTEGER NOT NULL DEFAULT 0;
