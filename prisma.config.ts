import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Use a direct (non-pooler) URL for Prisma CLI/migrations.
    // Keep DATABASE_URL for the running app/worker (pooler is fine there).
    url: process.env.DIRECT_URL ?? env("DATABASE_URL"),
  },
});

