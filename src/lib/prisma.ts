import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var prismaPool: Pool | undefined;
}

function getPool() {
  if (global.prismaPool) return global.prismaPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  global.prismaPool = new Pool({ connectionString });
  return global.prismaPool;
}

export const prisma =
  global.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(getPool()),
    log:
      process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") global.prisma = prisma;

