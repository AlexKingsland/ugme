/**
 * Sales attribution checks (no Shopify store needed).
 *
 *   npm run test:sales
 *
 * Runs against an isolated COPY of the dev database. Covers:
 *   • storefront markers (what the wall writes to the cart) round-trip into the order parser
 *   • direct vs influenced vs not credited, the 7-day window, per-product credit only
 *   • server-side verification (post must belong to the shop and link the product)
 *   • idempotent webhooks, refunds, and the dashboard summary
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const dir = mkdtempSync(join(tmpdir(), "social-wall-sales-"));
const dbFile = join(dir, "test.sqlite");
copyFileSync(resolve("prisma/dev.sqlite"), dbFile);
process.env.DATABASE_URL = `file:${dbFile}`;
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
(globalThis as any).prismaGlobal = prisma;

let passed = 0;
let failed = 0;
function check(name: string, ok: unknown, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── storefront stubs (the wall's attribution.ts runs in a browser) ──
const store = new Map<string, string>();
const cartUpdates: any[] = [];
let cartAttributes: Record<string, string> = {};
(globalThis as any).window = { Shopify: { routes: { root: "/" } } };
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
globalThis.fetch = (async (url: any, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("cart/update.js")) {
    const body = JSON.parse(String(init?.body));
    cartUpdates.push(body);
    cartAttributes = { ...cartAttributes, ...body.attributes };
    return new Response("{}", { status: 200 });
  }
  if (u.endsWith("cart.js")) return new Response(JSON.stringify({ attributes: cartAttributes }), { status: 200 });
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

const SHOP = "initialteststore-2.myshopify.com";
const DAY = 24 * 60 * 60;

async function main() {
  const wall = await import("../packages/canvas/src/attribution");
  const a = await import("../app/utils/attribution");
  const srv = await import("../app/utils/attribution.server");

  // ── fixtures: a wall + a post linked to products 9101 and 9102 ──
  const shop = await prisma.shop.upsert({ where: { shopDomain: SHOP }, update: {}, create: { shopDomain: SHOP, accessToken: "x" } });
  const other = await prisma.shop.upsert({ where: { shopDomain: "other-store.myshopify.com" }, update: {}, create: { shopDomain: "other-store.myshopify.com", accessToken: "x" } });
  const mkCampaign = (shopId: string, title: string) =>
    prisma.campaign.create({ data: { shopId, title, moment: "Test", status: "ACTIVE", rewardType: "NONE" } as any });
  const camp = await mkCampaign(shop.id, "Sales test wall");
  const otherCamp = await mkCampaign(other.id, "Someone else's wall");
  // Start from no orders (the copied dev DB may hold real test orders)
  await prisma.wallOrder.deleteMany({ where: { shopId: shop.id } });
  await prisma.wallPixelView.deleteMany({ where: { shopId: shop.id } });
  await prisma.wallRefund.deleteMany({ where: { shopId: shop.id } });
  await prisma.wallDailyStat.deleteMany({ where: { shopId: shop.id } });
  await prisma.wallPostDailyStat.deleteMany({ where: { shopId: shop.id } });
  const cust = await prisma.customer.create({ data: { shopId: shop.id, email: "sales-test@example.com" } as any });
  const otherCust = await prisma.customer.create({ data: { shopId: other.id, email: "sales-test@example.com" } as any });
  const products = JSON.stringify([
    { id: "gid://shopify/Product/9101", title: "Board", handle: "board", imageUrl: null },
    { id: "gid://shopify/Product/9102", title: "Wax", handle: "wax", imageUrl: null },
  ]);
  const post = await prisma.submission.create({ data: { campaignId: camp.id, customerId: cust.id, status: "APPROVED", contentUrl: "r2://x", products, displayName: "Sam" } });
  const foreignPost = await prisma.submission.create({ data: { campaignId: otherCamp.id, customerId: otherCust.id, status: "APPROVED", contentUrl: "r2://y", products } });
  const item = { id: post.id, wall: camp.id, type: "video" as const, src: "", products: JSON.parse(products) };

  console.log("\nStorefront markers");
  check("add to cart tags the line with wall + post", JSON.stringify(wall.directProperties(item)) === JSON.stringify({ _social_wall: `${camp.id}:${post.id}` }));
  check("no tag when the post has no wall id", wall.directProperties({ ...item, wall: undefined }) === undefined);
  wall.recordView(item);
  await new Promise((r) => setTimeout(r, 10));
  const seenValue = cartAttributes[a.SEEN_ATTRIBUTE];
  const seen = a.parseSeen(seenValue);
  check("watching a post writes its products to the cart attribute", seen.length === 2 && seen.every((e) => e.submissionId === post.id), seenValue);
  check("product ids are stored numeric", seen.map((e) => e.productId).sort().join() === "9101,9102");
  wall.recordView({ ...item, products: [] });
  check("posts without products record nothing", a.parseSeen(cartAttributes[a.SEEN_ATTRIBUTE]).length === 2);
  const before = cartUpdates.length;
  await wall.syncViewsToCart();
  check("re-sync skips the cart update when it already matches", cartUpdates.length === before);
  cartAttributes = {}; // new cart after a checkout
  await wall.syncViewsToCart();
  check("re-sync copies recent views onto a new cart", a.parseSeen(cartAttributes[a.SEEN_ATTRIBUTE]).length === 2);

  console.log("\nParsing");
  check("direct tag parses", JSON.stringify(a.parseDirectTag(`${camp.id}:${post.id}`)) === JSON.stringify({ campaignId: camp.id, submissionId: post.id }));
  check("junk direct tags are ignored", a.parseDirectTag("a:b:c") === null && a.parseDirectTag("<script>:x") === null && a.parseDirectTag("") === null);
  check("junk seen entries are skipped", a.parseSeen("1:abc:5,bad,2:x y:6,3:ok:7").length === 2);

  const now = Math.floor(Date.now() / 1000);
  const orderAt = new Date(now * 1000).toISOString();
  const money = (v: string) => ({ shop_money: { amount: v, currency_code: "USD" } });
  const line = (id: number, productId: number, price: string, qty = 1, extra: any = {}) => ({
    id, product_id: productId, title: `P${productId}`, quantity: qty, price, price_set: money(price), discount_allocations: [], properties: [], ...extra,
  });
  const seenAttr = (entries: [number, string, number][]) => ({ name: a.SEEN_ATTRIBUTE, value: entries.map((e) => e.join(":")).join(",") });

  const orderPayload = {
    id: 5001, name: "#1001", created_at: orderAt, currency: "USD", test: true,
    subtotal_price: "245.00", subtotal_price_set: money("245.00"),
    note_attributes: [seenAttr([[9102, post.id, now - 2 * DAY], [9103, post.id, now - 8 * DAY]])],
    line_items: [
      // added from the wall, 2 units, $10 off
      line(1, 9101, "50.00", 2, { properties: [{ name: "_social_wall", value: `${camp.id}:${post.id}` }], discount_allocations: [{ amount: "10.00", amount_set: money("10.00") }] }),
      line(2, 9102, "30.00"), // watched 2 days ago → influenced
      line(3, 9103, "40.00"), // watched 8 days ago → too old
      line(4, 9999, "85.00"), // never on the wall → nothing
    ],
  };
  const parsed = a.parseOrder(orderPayload)!;
  const byId = (id: string) => parsed.lines.find((l) => l.lineItemId === id);
  check("order revenue = subtotal after discounts", parsed.revenueCents === 24500, parsed.revenueCents);
  check("wall add-to-cart line → DIRECT", byId("1")?.kind === "DIRECT");
  check("direct revenue = price × qty − discounts", byId("1")?.revenueCents === 9000, byId("1")?.revenueCents);
  check("watched product bought within 7 days → INFLUENCED", byId("2")?.kind === "INFLUENCED" && byId("2")?.revenueCents === 3000);
  check("view older than 7 days → no credit", !byId("3"));
  check("rest of the cart → no credit", !byId("4"));
  const both = a.parseOrder({ ...orderPayload, note_attributes: [seenAttr([[9101, post.id, now - DAY]])] })!;
  check("a line that is both direct and seen counts once, as DIRECT", both.lines.filter((l) => l.lineItemId === "1").length === 1 && both.lines.find((l) => l.lineItemId === "1")?.kind === "DIRECT");
  const future = a.parseOrder({ ...orderPayload, note_attributes: [seenAttr([[9102, post.id, now + 3 * 60 * 60]])] })!;
  check("views stamped in the future are ignored", !future.lines.find((l) => l.lineItemId === "2"));
  check("most recent view wins", a.influencingView([{ productId: "1", submissionId: "old", t: now - 3 * DAY }, { productId: "1", submissionId: "new", t: now - DAY }], "1", now)?.submissionId === "new");

  console.log("\nRecording orders (webhook)");
  const r1 = await srv.recordOrder(SHOP, orderPayload);
  check("order recorded with 2 wall lines", "recorded" in r1 && r1.attributedLines === 2, r1);
  const stored = await prisma.wallOrder.findUnique({ where: { shopId_orderId: { shopId: shop.id, orderId: "5001" } }, include: { lines: true } });
  check("influenced line gets the post's wall", stored?.lines.find((l) => l.lineItemId === "2")?.campaignId === camp.id);
  const r2 = await srv.recordOrder(SHOP, orderPayload);
  check("redelivered webhook is ignored", "skipped" in r2 && r2.skipped === "duplicate");

  const forged = await srv.recordOrder(SHOP, {
    ...orderPayload, id: 5002, subtotal_price_set: money("100.00"),
    note_attributes: [seenAttr([[9102, foreignPost.id, now - DAY], [9999, post.id, now - DAY]])],
    line_items: [
      line(10, 9101, "50.00", 1, { properties: [{ name: "_social_wall", value: `${otherCamp.id}:${post.id}` }] }), // wrong wall for the post
      line(11, 9102, "30.00"), // post from another shop
      line(12, 9999, "20.00"), // product not linked to the post
    ],
  });
  check("forged / mismatched markers get no credit", "recorded" in forged && forged.attributedLines === 0, forged);
  check("…but the order still counts toward store revenue", (await prisma.wallOrder.count({ where: { shopId: shop.id, orderId: "5002" } })) === 1);
  check("unknown shops are skipped", "skipped" in (await srv.recordOrder("nope.myshopify.com", orderPayload)));

  console.log("\nCheckout pixel (\"Buy it now\" skips the cart)");
  const pixelSeen = JSON.stringify([{ p: "9102", s: post.id, t: now - DAY }, { p: "9999", s: post.id, t: now - DAY }]);
  check("pixel payload parses the wall's localStorage format", a.parsePixelSeen(pixelSeen).length === 2);
  check("junk pixel payloads parse to nothing", a.parsePixelSeen("nope").length === 0 && a.parsePixelSeen([{ p: "x" }]).length === 0);
  const buyNow = { ...orderPayload, id: 5003, note_attributes: [], subtotal_price_set: money("70.00"), line_items: [line(20, 9102, "30.00"), line(21, 9999, "40.00")] };
  // a) webhook first, pixel second
  await srv.recordOrder(SHOP, buyNow);
  let o3 = await prisma.wallOrder.findUnique({ where: { shopId_orderId: { shopId: shop.id, orderId: "5003" } }, include: { lines: true } });
  check("Buy it now order alone gets no credit (no cart attribute)", o3?.lines.length === 0);
  const applied = await srv.recordPixelViews(shop.id, "gid://shopify/Order/5003", a.parsePixelSeen(pixelSeen));
  o3 = await prisma.wallOrder.findUnique({ where: { shopId_orderId: { shopId: shop.id, orderId: "5003" } }, include: { lines: true } });
  check("pixel arriving after the webhook credits the watched product", "applied" in applied && applied.applied === 1 && o3?.lines[0]?.kind === "INFLUENCED" && o3?.lines[0]?.productId === "9102", applied);
  check("…and not the unlinked product in the same order", o3?.lines.length === 1);
  await srv.recordPixelViews(shop.id, "5003", a.parsePixelSeen(pixelSeen));
  check("repeat pixel reports don't double count", (await prisma.wallOrderLine.count({ where: { order: { orderId: "5003" } } })) === 1);
  // b) pixel first, webhook second
  await srv.recordPixelViews(shop.id, "gid://shopify/Order/5004", a.parsePixelSeen(pixelSeen));
  const r4 = await srv.recordOrder(SHOP, { ...buyNow, id: 5004 });
  check("pixel arriving before the webhook is applied when the order is recorded", "recorded" in r4 && r4.attributedLines === 1, r4);
  // c) a direct line is never re-credited by the pixel
  await srv.recordPixelViews(shop.id, "5001", a.parsePixelSeen(JSON.stringify([{ p: "9101", s: post.id, t: now - DAY }])));
  check("pixel never adds credit to a line that already has it", (await prisma.wallOrderLine.count({ where: { order: { orderId: "5001" } } })) === 2);
  // d) old views from the pixel are still held to the 7-day window
  await srv.recordOrder(SHOP, { ...buyNow, id: 5005 });
  await srv.recordPixelViews(shop.id, "5005", a.parsePixelSeen(JSON.stringify([{ p: "9102", s: post.id, t: now - 9 * DAY }])));
  check("pixel views older than 7 days get no credit", (await prisma.wallOrderLine.count({ where: { order: { orderId: "5005" } } })) === 0);

  console.log("\nRefunds");
  const refund = { id: 7001, order_id: 5001, refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: "45.00", subtotal_set: money("45.00") }] };
  await srv.recordRefund(SHOP, refund);
  await srv.recordRefund(SHOP, refund); // redelivery
  const afterRefund = await prisma.wallOrder.findUnique({ where: { shopId_orderId: { shopId: shop.id, orderId: "5001" } }, include: { lines: true } });
  check("refund reduces the line once", afterRefund?.lines.find((l) => l.lineItemId === "1")?.refundedCents === 4500, afterRefund?.lines.find((l) => l.lineItemId === "1")?.refundedCents);
  check("refund reduces the order total once", afterRefund?.refundedCents === 4500, afterRefund?.refundedCents);
  check("refunds for untracked orders are skipped", "skipped" in (await srv.recordRefund(SHOP, { ...refund, id: 7002, order_id: 999 })));

  console.log("\nDashboard summary");
  const s = await srv.getSalesSummary(shop.id, 30);
  check("direct = $90 − $45 refund", s.directCents === 4500, s.directCents);
  check("influenced = $30 + two Buy it now orders × $30", s.influencedCents === 9000, s.influencedCents);
  check("store revenue = $245 + $100 + 3 × $70 − $45", s.totalCents === 51000, s.totalCents);
  check("one point per day", s.series.length === 30);
  const today = s.series[s.series.length - 1];
  check("today's bar holds today's sales", today.direct === 4500 && today.influenced === 9000 && today.total === 51000, today);
  check("top post is the test post with both amounts", s.topPosts[0]?.submissionId === post.id && s.topPosts[0].directCents === 4500 && s.topPosts[0].influencedCents === 9000, s.topPosts[0]);
  check("top wall is the test wall", s.topWalls[0]?.campaignId === camp.id && s.topWalls[0].title === "Sales test wall");
  check("orders older than the range are excluded", (await srv.getSalesSummary(shop.id, 7)).totalCents === 51000);

  console.log("\nRollups (what the dashboard reads)");
  const snap = async () => ({
    days: (await prisma.wallDailyStat.findMany({ where: { shopId: shop.id }, orderBy: { day: "asc" } })).map((r) => [r.day, r.totalCents, r.directCents, r.influencedCents, r.directOrders, r.influencedOrders]),
    posts: (await prisma.wallPostDailyStat.findMany({ where: { shopId: shop.id }, orderBy: [{ day: "asc" }, { submissionId: "asc" }] })).map((r) => [r.day, r.submissionId, r.directCents, r.influencedCents]),
  });
  const incremental = await snap();
  check("one day row for today's orders", incremental.days.length === 1, incremental.days);
  check("orders counted per type (1 with direct, 3 with influenced)", incremental.days[0]?.[4] === 1 && incremental.days[0]?.[5] === 3, incremental.days[0]);
  await srv.rebuildSalesStats(shop.id, "UTC");
  const rebuilt = await snap();
  check("running totals equal a full recount (orders + pixel + refunds)", JSON.stringify(incremental) === JSON.stringify(rebuilt), { incremental, rebuilt });
  const otherDay = { ...orderPayload, id: 5010, created_at: "2026-10-01T23:30:00-07:00", note_attributes: [], line_items: [line(30, 9999, "10.00")], subtotal_price_set: money("10.00") };
  await srv.recordOrder(SHOP, otherDay);
  check("days follow the shop's clock (11:30pm local stays on that day)", !!(await prisma.wallDailyStat.findUnique({ where: { shopId_day: { shopId: shop.id, day: "2026-10-01" } } })));
  const before2 = await snap();
  await srv.recordOrder(SHOP, otherDay);
  check("duplicate webhooks don't move the totals", JSON.stringify(before2) === JSON.stringify(await snap()));

  console.log("\nCheckout pixel setup (respects merchants who turn it off)");
  const px = await import("../app/utils/web-pixel.server");
  let pixelOn = false;
  let creates = 0;
  const gql = (async (q: string) => {
    if (q.includes("webPixelCreate")) {
      creates++;
      pixelOn = true;
      return new Response(JSON.stringify({ data: { webPixelCreate: { webPixel: { id: "gid://shopify/WebPixel/1" }, userErrors: [] } } }));
    }
    if (pixelOn) return new Response(JSON.stringify({ data: { webPixel: { id: "gid://shopify/WebPixel/1" } } }));
    return new Response(JSON.stringify({ data: { webPixel: null }, errors: [{ message: "No web pixel was found for this app." }] }));
  }) as any;
  await prisma.shop.update({ where: { id: shop.id }, data: { pixelActivatedAt: null } });
  check("status reads 'off' when the store has no pixel", (await px.pixelStatus(gql)) === "off");
  await px.ensurePixelOnce(gql, SHOP);
  check("first visit turns the pixel on", creates === 1 && pixelOn);
  check("…and remembers it did", !!(await prisma.shop.findUnique({ where: { id: shop.id } }))?.pixelActivatedAt);
  pixelOn = false; // merchant disconnects it in Settings → Customer events
  await px.ensurePixelOnce(gql, SHOP);
  check("a merchant-disconnected pixel is NOT turned back on automatically", creates === 1 && !pixelOn);
  check("status shows 'off' so Analytics can offer to turn it on", (await px.pixelStatus(gql)) === "off");
  await px.activatePixel(gql, SHOP);
  check("the merchant's button turns it back on", creates === 2 && pixelOn);
  const throwing = (async () => { throw Object.assign(new Error("GraphQL"), { body: { errors: [{ message: "No web pixel was found" }] } }); }) as any;
  check("not-found thrown by the admin client also reads as 'off'", (await px.pixelStatus(throwing)) === "off");
  check("other failures read as 'unknown' (no false alarm)", (await px.pixelStatus((async () => { throw new Error("network"); }) as any)) === "unknown");

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
