-- AlterTable
ALTER TABLE "CrawlPageAudit" ADD COLUMN "hstsHeader" VARCHAR(512);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "cspHeader" TEXT;
ALTER TABLE "CrawlPageAudit" ADD COLUMN "xContentTypeOptionsHeader" VARCHAR(64);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "xFrameOptionsHeader" VARCHAR(64);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "referrerPolicyHeader" VARCHAR(128);
ALTER TABLE "CrawlPageAudit" ADD COLUMN "permissionsPolicyHeader" VARCHAR(1024);
