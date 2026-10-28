/**
 * Rebuild the sales dashboard rollups from recorded orders (backfill / repair).
 *
 *   npm run sales:rebuild [-- <IANA time zone>]
 *
 * Uses each shop's time zone from Shopify (offline session) for day boundaries; if
 * that can't be read (e.g. expired token), the optional argument is used instead.
 */
import prisma from "../app/db.server";
import { rebuildSalesStats } from "../app/utils/attribution.server";

const FALLBACK_TZ = process.argv[2] || "UTC";

async function timeZoneFor(shopDomain: string): Promise<string> {
  const s = await prisma.session.findFirst({ where: { shop: shopDomain, isOnline: false } });
  if (!s) return FALLBACK_TZ;
  try {
    const r = await fetch(`https://${shopDomain}/admin/api/2026-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": s.accessToken },
      body: JSON.stringify({ query: "{ shop { ianaTimezone } }" }),
    });
    return ((await r.json()) as any)?.data?.shop?.ianaTimezone || FALLBACK_TZ;
  } catch {
    return FALLBACK_TZ;
  }
}

async function main() {
  const shops = await prisma.shop.findMany({ select: { id: true, shopDomain: true } });
  for (const shop of shops) {
    if (!(await prisma.wallOrder.count({ where: { shopId: shop.id } }))) continue;
    const tz = await timeZoneFor(shop.shopDomain);
    const r = await rebuildSalesStats(shop.id, tz);
    console.log(`${shop.shopDomain}: rebuilt from ${r.orders} order(s) (${tz})`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
