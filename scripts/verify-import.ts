/**
 * Check a database loaded from prisma/sqlite-export.sql: row counts per table
 * must match what the export recorded.
 *
 *   npm run db:verify-import
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const sql = readFileSync("prisma/sqlite-export.sql", "utf8");
const m = sql.match(/-- expected rows: (\{.*\})/);
if (!m) throw new Error("prisma/sqlite-export.sql has no expected row counts");
const expected: Record<string, number> = JSON.parse(m[1]);
const prisma = new PrismaClient();
let bad = 0;
for (const [table, n] of Object.entries(expected)) {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*)::bigint AS count FROM "${table}"`);
  const got = Number(rows[0].count);
  console.log(`${got === n ? "✓" : "✗"} ${table}: ${got}${got === n ? "" : ` (expected ${n})`}`);
  if (got !== n) bad++;
}
console.log(bad ? `\n✗ ${bad} table(s) differ` : "\n✓ everything copied over");
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
