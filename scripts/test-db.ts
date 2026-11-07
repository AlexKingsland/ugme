/**
 * Isolated Postgres database for the test suites.
 *
 * Each run gets its own schema (test_<name>_<time>) in the Postgres from
 * TEST_DATABASE_URL (or DATABASE_URL), with the real migrations applied. It's
 * dropped at the end, so tests never touch your dev data.
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export function withSchema(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("schema", schema);
  return u.toString();
}

export function isolatedDatabase(name: string) {
  const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!base || !/^postgres(ql)?:\/\//.test(base)) {
    throw new Error("Tests need a Postgres URL in TEST_DATABASE_URL or DATABASE_URL (see .env.example).");
  }
  const schema = `test_${name}_${Date.now()}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const url = withSchema(base, schema);
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
  process.env.DATABASE_URL = url; // app code (db.server) connects here too
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  (globalThis as any).prismaGlobal = prisma;
  return {
    prisma,
    url,
    schema,
    /** Drop the schema and disconnect. */
    async cleanup() {
      try {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await prisma.$disconnect();
      }
    },
  };
}
