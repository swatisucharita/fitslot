import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "@/generated/prisma/client";

// "file:./dev.db" -> "./dev.db", resolved by SQLite relative to the working directory.
const url = (process.env.DATABASE_URL ?? "file:./dev.db").replace(/^file:/, "");

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Reuse one client across hot reloads in dev.
export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
