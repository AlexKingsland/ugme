/**
 * One-off: fill in missing product handles (+ images) on wall campaigns and
 * submissions created before products were stored with their handle. Without
 * a handle the wall can't show product cards and "Shop" links fall back to the
 * homepage.
 *
 *   node --env-file=.env --import tsx scripts/backfill-product-handles.ts [--dry-run]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");
type P = { id: string; title: string; handle: string | null; imageUrl: string | null };

const shops = await prisma.shop.findMany({ select: { id: true, shopDomain: true } });
for (const shop of shops) {
  const session = await prisma.session.findFirst({ where: { shop: shop.shopDomain, isOnline: false } });
  if (!session) continue;
  const campaigns = await prisma.campaign.findMany({ where: { shopId: shop.id }, select: { id: true, title: true, products: true } });
  const subs = await prisma.submission.findMany({ where: { campaign: { shopId: shop.id } }, select: { id: true, products: true } });
  const parse = (s: string): P[] => { try { return JSON.parse(s || "[]"); } catch { return []; } };
  const missing = new Set<string>();
  for (const row of [...campaigns, ...subs]) for (const p of parse(row.products)) if (!p.handle) missing.add(p.id);
  if (!missing.size) { console.log(`${shop.shopDomain}: nothing to fill`); continue; }

  const res = await fetch(`https://${shop.shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({
      query: `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title handle featuredMedia { preview { image { url } } } } } }`,
      variables: { ids: [...missing] },
    }),
  });
  const body: any = await res.json();
  if (body.errors) { console.log(`${shop.shopDomain}: ${JSON.stringify(body.errors)}`); continue; }
  const found = new Map<string, any>((body.data.nodes || []).filter(Boolean).map((n: any) => [n.id, n]));

  const fill = (list: P[]) => list.map((p) => {
    const n = found.get(p.id);
    return n && !p.handle ? { ...p, handle: n.handle, title: p.title || n.title, imageUrl: p.imageUrl || n.featuredMedia?.preview?.image?.url || null } : p;
  });
  let changed = 0;
  for (const c of campaigns) {
    const next = JSON.stringify(fill(parse(c.products)));
    if (next !== c.products) { changed++; console.log(`  campaign ${c.title}`); if (!dryRun) await prisma.campaign.update({ where: { id: c.id }, data: { products: next } }); }
  }
  for (const s of subs) {
    const next = JSON.stringify(fill(parse(s.products)));
    if (next !== s.products) { changed++; if (!dryRun) await prisma.submission.update({ where: { id: s.id }, data: { products: next } }); }
  }
  console.log(`${shop.shopDomain}: ${found.size}/${missing.size} products found, ${changed} row(s) ${dryRun ? "would be " : ""}updated`);
}
await prisma.$disconnect();
