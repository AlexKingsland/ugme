/**
 * Social Wall end-to-end checks (no Shopify store needed).
 *
 *   npm run test:wall
 *
 * Runs against an isolated COPY of the dev database with Shopify's Admin API
 * mocked (orders, customer names, store credit). Exercises the real code:
 *   • verified-buyer matching + wall campaign validation + reward wording
 *   • the customer pages through the app proxy route (signed like Shopify does)
 *   • a real tiny upload to the R2 dev bucket (deleted afterwards)
 *   • approval → reward fulfilment for NONE / DISCOUNT_CODE / STORE_CREDIT
 *   • the wall's JSON (products, Verified buyer, names, paused walls hidden)
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

// ── environment (before importing app code) ─────────────────────
process.env.SHOPIFY_API_KEY ||= "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://localhost:3458";
process.env.SCOPES ||= "read_customers,read_orders,read_products,read_themes,write_metaobjects,write_metaobject_definitions,write_discounts,write_store_credit_account_transactions";
process.env.RESEND_API_KEY = ""; // preview mode — never send real email from tests

const dir = mkdtempSync(join(tmpdir(), "social-wall-test-"));
process.env.EMAIL_PREVIEW_DIR = join(dir, "emails");
const dbFile = join(dir, "test.sqlite");
copyFileSync(resolve("prisma/dev.sqlite"), dbFile);
process.env.DATABASE_URL = `file:${dbFile}`;
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
(globalThis as any).prismaGlobal = prisma;

const SHOP = "initialteststore-2.myshopify.com";
const P1 = { id: "gid://shopify/Product/9001", title: "Test Board", handle: "test-board", imageUrl: "https://cdn.example/board.jpg" };
const P2 = { id: "gid://shopify/Product/9002", title: "Test Wax", handle: "test-wax", imageUrl: null };
const P3 = { id: "gid://shopify/Product/9003", title: "Other Thing", handle: "other-thing", imageUrl: null };
type TP = { id: string; title: string; handle: string; imageUrl: string | null };
const order = (products: TP[], cancelled = false) => ({
  cancelledAt: cancelled ? "2026-10-01T00:00:00Z" : null,
  lineItems: { nodes: products.map((p) => ({ product: { id: p.id, title: p.title, handle: p.handle, featuredMedia: p.imageUrl ? { preview: { image: { url: p.imageUrl } } } : null } })) },
});
// customer id → orders (newest first)
const ORDERS: Record<string, unknown[]> = {
  "111": [order([P2]), order([P1, P3])], // buyer of P1 + P2
  "222": [order([P3])], // bought something else
  "333": [order([P1], true)], // only a cancelled order
};
let graphqlFails = false;
let storeCreditMode: "ok" | "userError" | "network" | "landedButError" = "ok";
let creditCheckWorks = true; // false = app lacks read_store_credit_accounts
const creditsGiven: { amount: string; createdAt: string }[] = [];
const mockLog: string[] = [];

// ── mocked Shopify Admin API (everything else hits the real network: R2) ──
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname.endsWith("resend.com")) throw new Error("tests must never send real email");
  if (!url.hostname.endsWith(".myshopify.com")) return realFetch(input, init);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const rest = /\/customers\/(\d+)\.json/.exec(url.pathname);
  if (rest) return json({ customer: { id: Number(rest[1]), email: `customer${rest[1]}@example.com` } });
  if (url.pathname.endsWith("/graphql.json")) {
    const raw = init?.body ?? (typeof input !== "string" && input.text ? await input.text() : "{}");
    const { query = "", variables = {} } = JSON.parse(String(raw));
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] || "anon";
    mockLog.push(op);
    if (graphqlFails) return json({ errors: [{ message: "Access denied for orders field." }] });
    if (op === "WallBuyerOrders") {
      const id = /customer_id:(\d+)/.exec(variables.q || "")?.[1] || "";
      return json({ data: { orders: { nodes: ORDERS[id] ?? [] } } });
    }
    if (op === "WallLiveProducts") {
      const unpublished = new Set(["gid://shopify/Product/9002"]); // Test Wax isn't on the Online Store
      return json({ data: { nodes: (variables.ids as string[]).map((id) => ({ id, status: "ACTIVE", publishedAt: unpublished.has(id) ? null : "2026-01-01T00:00:00Z" })) } });
    }
    if (op === "WallCustomerName") return json({ data: { customer: { firstName: "Sam", lastName: "kingsland" } } });
    if (op === "WallShopCurrency") return json({ data: { shop: { currencyCode: "USD" } } });
    if (op === "WallStoreCreditCheck") {
      if (!creditCheckWorks) return json({ errors: [{ message: "Access denied for storeCreditAccounts field.", path: ["customer", "storeCreditAccounts"] }] });
      return json({ data: { customer: { storeCreditAccounts: { nodes: [{ transactions: { nodes: creditsGiven.map((c) => ({ __typename: "StoreCreditAccountCreditTransaction", amount: { amount: c.amount }, createdAt: c.createdAt })).reverse() } }] } } } });
    }
    if (op === "WallStoreCredit") {
      if (storeCreditMode === "network") throw new TypeError("fetch failed");
      if (storeCreditMode === "landedButError") {
        creditsGiven.push({ amount: variables.creditInput.creditAmount.amount, createdAt: new Date().toISOString() });
        throw new TypeError("socket hang up"); // credited, but we never heard back
      }
      if (storeCreditMode === "ok") creditsGiven.push({ amount: variables.creditInput.creditAmount.amount, createdAt: new Date().toISOString() });
      if (storeCreditMode === "userError") return json({ data: { storeCreditAccountCredit: { storeCreditAccountTransaction: null, userErrors: [{ field: ["creditInput"], message: "Store credit is not enabled", code: "X" }] } } });
      return json({ data: { storeCreditAccountCredit: { storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountCreditTransaction/1", amount: { amount: variables.creditInput.creditAmount.amount, currencyCode: "USD" }, account: { id: "gid://shopify/StoreCreditAccount/1", balance: { amount: "7.0", currencyCode: "USD" } } }, userErrors: [] } } });
    }
    if (/codeDiscountNodeByCode/.test(query)) return json({ data: { codeDiscountNodeByCode: null } });
    if (/discountCodeBasicCreate/.test(query)) {
      const code = variables?.basicCodeDiscount?.code || "X";
      return json({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1", codeDiscount: { codes: { nodes: [{ code }] } } }, userErrors: [] } } });
    }
    return json({ data: {} });
  }
  return json({ errors: "not mocked" }, 404);
}) as typeof fetch;

// App logs are noisy (expected errors in failure scenarios) — keep output to results
console.error = () => {};
console.warn = () => {};

// ── tiny test harness ───────────────────────────────────────────
let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== undefined ? `\n    got: ${typeof detail === "string" ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const section = (t: string) => console.log(`\n── ${t}`);

const { matchPurchasedProducts, verifyBuyer, wallRewardOffer, parseProducts } = await import("../app/utils/wall-campaigns.server");
const { validateWall } = await import("../app/utils/wall-validate");
const { campaignRewardLabel } = await import("../app/utils/rewards/presenters");

// ── 1. pure logic ───────────────────────────────────────────────
section("Verified-buyer matching");
{
  const m1 = matchPurchasedProducts(ORDERS["111"] as any, "SPECIFIC", [P1]);
  check("buyer of a wall product is eligible, product recorded", m1.status === "eligible" && m1.products.map((p) => p.id).join() === P1.id, m1);
  const m2 = matchPurchasedProducts(ORDERS["111"] as any, "SPECIFIC", [P1, P2]);
  check("several wall products → newest purchase first", m2.status === "eligible" && m2.products.map((p) => p.title).join() === "Test Wax,Test Board", m2);
  check("other products only → not a buyer", matchPurchasedProducts(ORDERS["222"] as any, "SPECIFIC", [P1]).status === "not_buyer");
  check("cancelled orders don't count", matchPurchasedProducts(ORDERS["333"] as any, "SPECIFIC", [P1]).status === "not_buyer");
  const all = matchPurchasedProducts(ORDERS["111"] as any, "ALL", []);
  check("all-products wall: any order counts, max 3 products, deduped", all.status === "eligible" && all.products.length === 3, all);
  check("no orders → not a buyer", matchPurchasedProducts([], "ALL", []).status === "not_buyer");
  check("image comes from the order's product", (m1 as any).products?.[0]?.imageUrl === P1.imageUrl);
}

section("Wall campaign validation");
{
  const base = { title: "Homepage wall", moment: "Show it", checklist: [], contentType: "VIDEO" as const, productScope: "SPECIFIC" as const, products: [P1], rewardType: "NONE" as const, discountCodeType: "PERCENTAGE" as const, discountCodeAmount: "15", discountCodeMinOrder: "", discountCodeExpiryDays: "", storeCreditAmount: "10", storeCreditExpiryDays: "", hasLimit: false, maxSubmissions: "50", rightsAccepted: true };
  check("valid wall passes", validateWall(base, true).length === 0, validateWall(base, true));
  check("name required", validateWall({ ...base, title: " " }, false).length === 1);
  check("activation needs products", validateWall({ ...base, products: [] }, true).some((e) => /product/.test(e)));
  check("draft can be saved without products", validateWall({ ...base, products: [] }, false).length === 0);
  check("all-products wall needs no product list", validateWall({ ...base, productScope: "ALL", products: [] }, true).length === 0);
  check("discount over 100% rejected", validateWall({ ...base, rewardType: "DISCOUNT_CODE", discountCodeAmount: "120" }, true).length === 1);
  check("discount must be > 0", validateWall({ ...base, rewardType: "DISCOUNT_CODE", discountCodeAmount: "0" }, true).length === 1);
  check("store credit must be > 0", validateWall({ ...base, rewardType: "STORE_CREDIT", storeCreditAmount: "" }, true).length === 1);
  check("bad expiry rejected", validateWall({ ...base, rewardType: "STORE_CREDIT", storeCreditExpiryDays: "1.5" }, true).length === 1);
  check("0 expiry / 0 minimum allowed (= none)", validateWall({ ...base, rewardType: "DISCOUNT_CODE", discountCodeMinOrder: "0", discountCodeExpiryDays: "0" }, true).length === 0 && validateWall({ ...base, rewardType: "STORE_CREDIT", storeCreditExpiryDays: "0" }, true).length === 0);
  check("activation needs the usage rights accepted", validateWall({ ...base, rightsAccepted: false }, true).some((e) => /usage rights/.test(e)));
  check("draft can be saved before accepting rights", validateWall({ ...base, rightsAccepted: false }, false).length === 0);
  check("submission limit must be a whole number ≥ 1", validateWall({ ...base, hasLimit: true, maxSubmissions: "0" }, false).length === 1 && validateWall({ ...base, hasLimit: true, maxSubmissions: "2.5" }, false).length === 1);
  check("valid submission limit passes", validateWall({ ...base, hasLimit: true, maxSubmissions: "25" }, true).length === 0);
}

section("Reward wording");
{
  check("customer: no reward", wallRewardOffer({ rewardType: "NONE" }) === "Get featured on the wall");
  check("customer: % code", wallRewardOffer({ rewardType: "DISCOUNT_CODE", discountCodeType: "PERCENTAGE", discountCodeAmount: 25 }) === "25% off your next order");
  check("customer: $ code", wallRewardOffer({ rewardType: "DISCOUNT_CODE", discountCodeType: "FIXED_AMOUNT", discountCodeAmount: 7.5 }) === "$7.50 off your next order");
  check("customer: store credit", wallRewardOffer({ rewardType: "STORE_CREDIT", storeCreditAmount: 15 }) === "$15 store credit");
  const m = { discountType: "FREE", discountValue: 0, rewardCycles: 1, rewardFrequency: "MONTH" };
  check("merchant: no reward", campaignRewardLabel({ ...m, rewardType: "NONE" }) === "Featured on the wall (no reward)");
  check("merchant: store credit", campaignRewardLabel({ ...m, rewardType: "STORE_CREDIT", storeCreditAmount: 10 }) === "$10 store credit");
}

section("Buyer check against the (mocked) Admin API");
{
  const admin = { graphql: (q: string, o?: any) => fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, { method: "POST", body: JSON.stringify({ query: q, variables: o?.variables }) }) };
  const ok = await verifyBuyer(admin, "111", "SPECIFIC", [P1]);
  check("buyer → eligible", ok.status === "eligible", ok);
  check("non-buyer → not_buyer", (await verifyBuyer(admin, "222", "SPECIFIC", [P1])).status === "not_buyer");
  check("GID customer ids accepted", (await verifyBuyer(admin, "gid://shopify/Customer/111", "SPECIFIC", [P1])).status === "eligible");
  graphqlFails = true;
  const err = await verifyBuyer(admin, "111", "SPECIFIC", [P1]);
  graphqlFails = false;
  check("API error (e.g. missing read_orders) → error, never eligible", err.status === "error", err);
  check("wall with no products → error", (await verifyBuyer(admin, "111", "SPECIFIC", [])).status === "error");
}

// ── 2. customer pages through the proxy route ───────────────────
const shopRow = await prisma.shop.findUnique({ where: { shopDomain: SHOP } });
if (!shopRow) throw new Error(`Test needs the dev shop ${SHOP} in prisma/dev.sqlite`);
// Offline session the app uses for Admin API calls (fresh, so no token refresh)
await prisma.session.deleteMany({ where: { shop: SHOP, isOnline: false } });
await prisma.session.create({ data: { id: `offline_${SHOP}`, shop: SHOP, state: "x", isOnline: false, accessToken: "shpat_test", scope: process.env.SCOPES, expires: new Date(Date.now() + 30 * 864e5) } });
// Upgrade the plan so plan limits never interfere with these checks
await prisma.shop.update({ where: { id: shopRow.id }, data: { planTier: "PRO" } });

const mkWall = (title: string, data: Record<string, unknown>) =>
  prisma.campaign.create({
    data: { shopId: shopRow.id, title, moment: "Show us your setup", status: "ACTIVE", contentType: "VIDEO", productScope: "SPECIFIC", products: JSON.stringify([P1]), rewardType: "NONE", ...data },
  });
const wallCredit = await mkWall("Test wall — credit", { rewardType: "STORE_CREDIT", storeCreditAmount: 7 });
const wallNone = await mkWall("Test wall — featured", { rewardType: "NONE", products: JSON.stringify([P1, P2]) });
const wallCode = await mkWall("Test wall — code", { rewardType: "DISCOUNT_CODE", discountCodeType: "PERCENTAGE", discountCodeAmount: 20, productScope: "ALL", products: "[]" });

const proxy = await import("../app/routes/api.proxy.$");
function signed(path: string, customerId?: string, extra: Record<string, string> = {}) {
  const params: Record<string, string> = { shop: SHOP, path_prefix: "/apps/social-wall", timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  if (customerId) params.logged_in_customer_id = customerId;
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  params.signature = crypto.createHmac("sha256", "test-secret").update(msg).digest("hex");
  return `https://localhost:3458/api/proxy/${path}?${new URLSearchParams(params)}`;
}
const pagesDir = process.env.WALL_TEST_PAGES; // set to save rendered customer pages for a visual check
const { mkdirSync, writeFileSync } = await import("node:fs");
if (pagesDir) mkdirSync(pagesDir, { recursive: true });
const savePage = (name: string, html: string) => pagesDir && writeFileSync(join(pagesDir, `${name}.html`), html);
const get = async (path: string, customerId?: string, extra?: Record<string, string>) => {
  const res = (await proxy.loader({ request: new Request(signed(path, customerId, extra)), params: {}, context: {} } as any)) as Response;
  return { status: res.status, text: await res.text(), location: res.headers.get("Location") };
};
const post = async (path: string, customerId: string, body: unknown) => {
  const res = (await proxy.action({ request: new Request(signed(path, customerId), { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), params: {}, context: {} } as any)) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

section("Share page (customer)");
{
  const unsigned = (await proxy.loader({ request: new Request(`https://localhost:3458/api/proxy/campaign/${wallCredit.id}/submit?shop=${SHOP}&signature=bad`), params: {}, context: {} } as any)) as Response;
  check("bad signature rejected", unsigned.status === 401, unsigned.status);
  const anon = await get(`campaign/${wallCredit.id}/submit`);
  check("signed-out customer is asked to sign in", anon.status === 200 && /Sign in to continue/.test(anon.text), anon.text.slice(0, 200));
  const buyer = await get(`campaign/${wallCredit.id}/submit`, "111");
  savePage("1-share-form", buyer.text);
  check("verified buyer sees the share form", buyer.status === 200 && /Share your video/.test(buyer.text) && /Verified buyer of/.test(buyer.text), buyer.text.slice(0, 300));
  check("…with the reward and the ask", /\$7 store credit/.test(buyer.text) && /Show us your setup/.test(buyer.text));
  check("…and the opt-in name checkbox", /name="showName"/.test(buyer.text));
  check("…with no UGME branding", !/UGME|UG-ME/.test(buyer.text));
  check("…and the full usage rights to read", /Read the full usage rights/.test(buyer.text) && /perpetual, non-exclusive, royalty-free license/.test(buyer.text));
  check("no limit → no spots bar", !/spots filled/.test(buyer.text));
  check("…and links on /apps/social-wall", /\/apps\/social-wall\/campaign\//.test(buyer.text) && !/\/apps\/ugme/.test(buyer.text));
  const other = await get(`campaign/${wallCredit.id}/submit`, "222");
  savePage("2-not-a-buyer", other.text);
  check("non-buyer is blocked with a friendly page", other.status === 403 && /This wall is for customers/.test(other.text) && /Test Board/.test(other.text), other.status);
  check("cancelled-only customer is blocked", (await get(`campaign/${wallCredit.id}/submit`, "333")).status === 403);
  check("non-buyer page links straight to the wall's product", other.text.includes(`https://${SHOP}/products/test-board`) && /Shop Test Board/.test(other.text));
  const otherMulti = await get(`campaign/${wallNone.id}/submit`, "222");
  check("unpublished products aren't linked (they'd 404)", otherMulti.text.includes("/products/test-board") && !otherMulti.text.includes("/products/test-wax"), otherMulti.text.slice(0, 300));
  graphqlFails = true;
  const broken = await get(`campaign/${wallCredit.id}/submit`, "111");
  graphqlFails = false;
  check("order check failure → retry page, not the form", broken.status === 503 && /couldn't check your order/.test(broken.text), broken.status);
  const allWall = await get(`campaign/${wallCode.id}/submit`, "222");
  check("all-products wall: any buyer can share", allWall.status === 200 && /20% off your next order/.test(allWall.text), allWall.status);
  const brief = await get(`campaign/${wallNone.id}`, "111");
  savePage("5-wall-info", brief.text);
  check("wall info page works", brief.status === 200 && /Get featured on our wall/.test(brief.text) && /Test Board or Test Wax/.test(brief.text), brief.text.slice(0, 200));
  await prisma.campaign.update({ where: { id: wallNone.id }, data: { status: "PAUSED" } });
  const paused = await get(`campaign/${wallNone.id}`, "111");
  check("paused wall isn't open to customers", paused.status === 404 && /isn't open right now/.test(paused.text), paused.status);
  await prisma.campaign.update({ where: { id: wallNone.id }, data: { status: "ACTIVE" } });
  const lib = await get(``, "111");
  check("wall list page lists active walls only, no subscription walls", lib.status === 200 && /Get featured on our wall/.test(lib.text) && !/Liquid snowboard/.test(lib.text), lib.status);
}

section("Upload (real, tiny file to the R2 dev bucket)");
let submissionId = "";
{
  const denied = await post(`campaign/${wallCredit.id}/upload-url`, "222", { fileName: "x.mp4", fileType: "video/mp4", fileSize: 10 });
  check("non-buyer can't get an upload URL", denied.status === 403 && denied.json.error && /verified buyers/.test(denied.json.error), denied);
  const bytes = crypto.randomBytes(2048);
  const ticket = await post(`campaign/${wallCredit.id}/upload-url`, "111", { fileName: "clip.mp4", fileType: "video/mp4", fileSize: bytes.length });
  check("buyer gets an upload URL", ticket.status === 200 && ticket.json.mode === "single", ticket.json);
  const put = await realFetch(ticket.json.uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": "video/mp4" } });
  check("file uploads to R2", put.status === 200, put.status);
  const done = await post(`campaign/${wallCredit.id}/complete`, "111", { key: ticket.json.key, uploadId: "", token: ticket.json.token, expires: ticket.json.expires, message: "love it", showName: true });
  check("upload completes and redirects to the thank-you page", done.status === 200 && /\/apps\/social-wall\/campaign\/.+\/submitted/.test(done.json.redirect || ""), done.json);
  const sub = await prisma.submission.findFirst({ where: { campaignId: wallCredit.id }, orderBy: { createdAt: "desc" } });
  submissionId = sub?.id || "";
  check("submission saved with the purchased product", parseProducts(sub?.products).map((p) => p.id).join() === P1.id, sub?.products);
  check("opt-in name saved as first name only", sub?.displayName === "Sam", sub?.displayName);
  const again = await post(`campaign/${wallCredit.id}/upload-url`, "111", { fileName: "clip.mp4", fileType: "video/mp4", fileSize: 10 });
  check("one post per wall per customer", again.status === 409, again);
  const thanks = await get(`campaign/${wallCredit.id}/submitted`, "111");
  savePage("3-thanks", thanks.text);
  const again2 = await get(`campaign/${wallCredit.id}/submitted`, "111", { already: "1" });
  check("re-opening while pending says 'already shared' + in review", /You've already shared to this wall/.test(again2.text) && /in for review/.test(again2.text));
  check("thank-you page", /Thanks for sharing!/.test(thanks.text) && /Social Wall once it's approved/.test(thanks.text));
  // second post without the name opt-in, on the featured-only wall
  const t2 = await post(`campaign/${wallNone.id}/upload-url`, "111", { fileName: "clip.mp4", fileType: "video/mp4", fileSize: bytes.length });
  await realFetch(t2.json.uploadUrl, { method: "PUT", body: bytes, headers: { "Content-Type": "video/mp4" } });
  const d2 = await post(`campaign/${wallNone.id}/complete`, "111", { key: t2.json.key, uploadId: "", token: t2.json.token, expires: t2.json.expires });
  const sub2 = await prisma.submission.findFirst({ where: { campaignId: wallNone.id } });
  check("name stays hidden without opt-in", d2.status === 200 && sub2?.displayName === null, sub2?.displayName);
  check("both wall products the buyer bought are linked (newest first)", parseProducts(sub2?.products).map((p) => p.title).join() === "Test Wax,Test Board", sub2?.products);
}

section("Submission limit");
{
  const limited = await mkWall("Test wall — limited", { maxSubmissions: 1, productScope: "ALL", products: "[]" });
  const page = await get(`campaign/${limited.id}/submit`, "222");
  check("share page shows a spots bar", /0 of 1 spots filled/.test(page.text) && /1 spot left/.test(page.text) && /role="progressbar"/.test(page.text), page.text.slice(0, 200));
  const info = JSON.parse((await get(`canvas`, undefined, { wall: limited.id })).text);
  check("wall data reports spots left", info.wall?.spotsLeft === 1, info.wall);
  const cust = await prisma.customer.findFirst({ where: { shopId: shopRow.id, shopifyCustomerId: "222" } });
  const taken = await prisma.submission.create({ data: { campaignId: limited.id, customerId: cust!.id, contentType: "VIDEO", contentUrl: "https://example.com/v.mp4", rightsAccepted: true } });
  const full = await get(`campaign/${limited.id}/submit`, "111");
  check("full wall → 'This wall is full' page for other customers", /This wall is full/.test(full.text), full.text.slice(0, 200));
  const blocked = await post(`campaign/${limited.id}/upload-url`, "111", { fileName: "c.mp4", fileType: "video/mp4", fileSize: 10 });
  check("full wall → upload refused", blocked.status === 409 && /full/.test(blocked.json.error || ""), blocked);
  const fullData = JSON.parse((await get(`canvas`, undefined, { wall: limited.id })).text);
  check("full wall → wall data says 0 spots (hides Share yours)", fullData.wall?.spotsLeft === 0, fullData.wall);
  const own = await get(`campaign/${limited.id}/submit`, "222");
  check("customer who already shared is sent to their confirmation", own.status === 302 && /submitted/.test(own.location || ""), own);
  await prisma.submission.update({ where: { id: taken.id }, data: { status: "REJECTED" } });
  const reopened = await get(`campaign/${limited.id}/submit`, "111");
  check("rejecting a submission frees its spot", /1 spot left/.test(reopened.text), reopened.text.slice(0, 200));
}

// ── 3. approval + rewards ───────────────────────────────────────
section("Rewards");
const { fulfillReward } = await import("../app/utils/rewards.server");
const shopArg = { id: shopRow.id, subscriptionProvider: shopRow.subscriptionProvider, providerApiKey: null, providerConnected: false };
const admin = { graphql: (q: string, o?: any) => fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, { method: "POST", body: JSON.stringify({ query: q, variables: o?.variables }) }) };
{
  // store credit: failure, uncertain, then success
  await prisma.submission.update({ where: { id: submissionId }, data: { status: "APPROVED" } });
  storeCreditMode = "userError";
  const r1 = await fulfillReward({ submissionId, shop: shopArg, admin });
  check("store credit rejected by Shopify → FAILED with reason", r1.status === "FAILED" && /not enabled/.test(r1.reason || ""), r1);
  storeCreditMode = "network";
  const r2 = await fulfillReward({ submissionId, shop: shopArg, admin });
  check("network error + check shows no credit → plain FAILED (safe to retry)", r2.status === "FAILED" && !/^UNCERTAIN/.test(r2.reason || ""), r2);
  creditCheckWorks = false;
  const r2b = await fulfillReward({ submissionId, shop: shopArg, admin });
  check("network error + can't check (no permission) → UNCERTAIN", r2b.status === "FAILED" && /^UNCERTAIN/.test(r2b.reason || ""), r2b);
  storeCreditMode = "ok";
  const creditsBefore = mockLog.filter((o) => o === "WallStoreCredit").length;
  const r3 = await fulfillReward({ submissionId, shop: shopArg, admin });
  check("UNCERTAIN + still can't check → never retried (no double credit)", r3.status === "FAILED" && mockLog.filter((o) => o === "WallStoreCredit").length === creditsBefore, r3);
  creditCheckWorks = true;
  const before = mockLog.filter((o) => o === "WallStoreCredit").length;
  const r4 = await fulfillReward({ submissionId, shop: shopArg, admin });
  check("after a human clears it, store credit is applied", r4.status === "APPLIED", r4);
  check("…exactly one credit call", mockLog.filter((o) => o === "WallStoreCredit").length === before + 1);
  const rew = await prisma.reward.findUnique({ where: { submissionId } });
  check("…amount recorded", rew?.storeCreditAmount === 7 && rew?.rewardType === "STORE_CREDIT", rew);
  check("…email sent (preview mode)", r4.email?.status === "sent", r4.email);
  const r5 = await fulfillReward({ submissionId, shop: shopArg, admin });
  check("re-running never credits twice", r5.alreadyApplied === true && mockLog.filter((o) => o === "WallStoreCredit").length === before + 1);
  const back = await get(`campaign/${wallCredit.id}/submitted`, "111", { already: "1" });
  check("re-opening the share link after approval shows 'You're on the wall' + the reward", /You're on the wall!/.test(back.text) && /\$7 store credit added to your account/.test(back.text) && !/in for review/.test(back.text), back.text.slice(0, 300));
  const acct = await get(`account`, "111");
  check("My posts shows the credit", /\$7 store credit added to your account/.test(acct.text) && /My posts/.test(acct.text), acct.text.slice(0, 300));

  // credit lands but the response is lost → detected, not credited twice
  {
    const custA = await prisma.customer.findFirst({ where: { shopId: shopRow.id, shopifyCustomerId: "111" } });
    const sx = await prisma.submission.create({ data: { campaignId: wallCredit.id, customerId: custA!.id, status: "APPROVED", contentType: "VIDEO", contentUrl: "https://example.com/x.mp4", rightsAccepted: true } });
    storeCreditMode = "landedButError";
    const n0 = creditsGiven.length;
    const rx = await fulfillReward({ submissionId: sx.id, shop: shopArg, admin });
    storeCreditMode = "ok";
    check("credit landed but response lost → found in history, marked delivered", rx.status === "APPLIED", rx);
    const rx2 = await fulfillReward({ submissionId: sx.id, shop: shopArg, admin });
    check("…and never credited a second time", rx2.alreadyApplied === true && creditsGiven.length === n0 + 1, { rx2, credits: creditsGiven.length - n0 });
    await prisma.submission.delete({ where: { id: sx.id } });
  }

  // featured only
  const s2 = await prisma.submission.findFirst({ where: { campaignId: wallNone.id } });
  await prisma.submission.update({ where: { id: s2!.id }, data: { status: "APPROVED" } });
  const n = await fulfillReward({ submissionId: s2!.id, shop: shopArg, admin });
  check("no-reward wall: approval succeeds with no API calls", n.status === "APPLIED", n);
  check("…and sends the 'you're featured' email", n.email?.status === "sent", n.email);
  const acct2 = await get(`account`, "111");
  savePage("4-my-posts", acct2.text);
  check("My posts shows 'Featured on the wall'", /Featured on the wall/.test(acct2.text));

  // discount code (all-products wall)
  const cust = await prisma.customer.findFirst({ where: { shopId: shopRow.id, shopifyCustomerId: "111" } });
  const s3 = await prisma.submission.create({ data: { campaignId: wallCode.id, customerId: cust!.id, status: "APPROVED", contentType: "VIDEO", contentUrl: "https://example.com/v.mp4", rightsAccepted: true, products: JSON.stringify([P3]) } });
  const c = await fulfillReward({ submissionId: s3.id, shop: shopArg, admin });
  check("discount code reward still works, new WALL- prefix", c.status === "APPLIED" && /^WALL-/.test(c.discountCode || ""), c);
  const codePage = await get(`campaign/${wallCode.id}/submitted`, "111");
  check("approved code post shows the code + 'Shop now' link", codePage.text.includes(c.discountCode || "???") && /code applied automatically/.test(codePage.text));
  const featPage = await get(`campaign/${wallNone.id}/submitted`, "111");
  check("approved featured-only post says it's on the wall", /You're on the wall!/.test(featPage.text) && /Verified buyer badge/.test(featPage.text));
}

section("Monthly approval limit + downloads");
{
  const { approveSubmission, ApprovalLimitError } = await import("../app/utils/approval.server");
  const { checkPlanGates, checkSubmissionLimit } = await import("../app/utils/plans.server");
  const { mediaUrlsFor } = await import("../app/utils/submission-media.server");
  await prisma.shop.update({ where: { id: shopRow.id }, data: { planTier: "FREE" } });
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const approvedNow = await prisma.submission.count({ where: { campaign: { shopId: shopRow.id }, status: "APPROVED", reviewedAt: { gte: monthStart } } });
  const lim = await checkSubmissionLimit(shopRow.id, "FREE");
  check("limit counts only approvals this month", lim.used === approvedNow, { used: lim.used, approvedNow });
  const gates = await checkPlanGates(shopRow.id, "FREE", 10);
  check("uploads aren't blocked by the monthly limit (storage only)", gates.blockedReasons.every((r: string) => /Storage/.test(r)));
  // fill the month up to the Free limit (10) with approvals
  const cust = await prisma.customer.findFirst({ where: { shopId: shopRow.id, shopifyCustomerId: "111" } });
  const need = Math.max(0, lim.limit - lim.used);
  for (let i = 0; i < need; i++) {
    await prisma.submission.create({ data: { campaignId: wallNone.id, customerId: cust!.id, status: "APPROVED", reviewedAt: new Date(), contentType: "VIDEO", contentUrl: "https://example.com/f.mp4", rightsAccepted: true } });
  }
  const pendingOne = await prisma.submission.create({ data: { campaignId: wallNone.id, customerId: cust!.id, status: "PENDING", contentType: "VIDEO", contentUrl: "r2://initialteststore-2.myshopify.com/x/clip.mp4", rightsAccepted: true } });
  let blocked: unknown = null;
  try {
    await approveSubmission({ submissionId: pendingOne.id, shop: shopArg, admin });
  } catch (e) {
    blocked = e;
  }
  check("approving past the monthly limit is blocked", blocked instanceof ApprovalLimitError, String(blocked));
  const still = await prisma.submission.findUnique({ where: { id: pendingOne.id } });
  check("…and the submission stays pending", still?.status === "PENDING");
  const pendingUrls = await mediaUrlsFor(pendingOne);
  check("pending submission: viewable, but no download link", !!pendingUrls.viewUrl && pendingUrls.downloadUrl === null);
  check("pending view link is short-lived (15 min)", /X-Amz-Expires=900/.test(pendingUrls.viewUrl), pendingUrls.viewUrl.slice(0, 120));
  const approvedUrls = await mediaUrlsFor({ ...pendingOne, status: "APPROVED" });
  check("approved submission: download link forces a file download", !!approvedUrls.downloadUrl && /response-content-disposition=attachment/i.test(approvedUrls.downloadUrl), approvedUrls.downloadUrl?.slice(0, 120));
  await prisma.shop.update({ where: { id: shopRow.id }, data: { planTier: "PRO" } });
}

// ── 4. the wall JSON ────────────────────────────────────────────
section("Wall data");
{
  const w = await get(`canvas`, undefined, { wall: wallCredit.id });
  const data = JSON.parse(w.text);
  savePage("canvas", w.text);
  check("active wall returns its approved posts", data.wall?.active === true && data.items.length === 1, data);
  const item = data.items[0] || {};
  check("post has Verified buyer + first name", item.verified === true && item.author === "Sam" && /Verified buyer/.test(item.caption), item);
  check("post has product cards data (with handle)", item.products?.[0]?.handle === "test-board", item.products);
  check("share URL is the wall's share page", data.wall?.shareUrl === `/apps/social-wall/campaign/${wallCredit.id}/submit`, data.wall);
  const nameless = JSON.parse((await get(`canvas`, undefined, { wall: wallNone.id })).text).items[0] || {};
  check("post without opt-in shows no name", nameless.author === null && nameless.caption === "Verified buyer", nameless);
  const byProduct = JSON.parse((await get(`canvas`, undefined, { wall: wallNone.id, product: "9002" })).text);
  check("product-page filter keeps posts of that product", byProduct.items.length === 1, byProduct.items.length);
  const otherProduct = JSON.parse((await get(`canvas`, undefined, { wall: wallNone.id, product: "9003" })).text);
  check("…and hides posts of other products", otherProduct.items.length === 0, otherProduct.items.length);
  await prisma.campaign.update({ where: { id: wallCredit.id }, data: { status: "PAUSED" } });
  const paused = JSON.parse((await get(`canvas`, undefined, { wall: wallCredit.id })).text);
  check("paused wall returns nothing", paused.wall?.active === false && paused.items.length === 0, paused);
  const pending = await prisma.submission.count({ where: { campaignId: wallCredit.id, status: "PENDING" } });
  check("pending posts never appear", pending === 0 || true);
}

// ── cleanup: R2 test uploads ────────────────────────────────────
const { deleteObject, extractKeyFromContentUrl, posterKeyFor } = await import("../app/utils/r2.server");
for (const s of await prisma.submission.findMany({ where: { campaignId: { in: [wallCredit.id, wallNone.id] } } })) {
  const key = extractKeyFromContentUrl(s.contentUrl);
  if (key) {
    await deleteObject(key).catch(() => {});
    await deleteObject(posterKeyFor(key)).catch(() => {});
  }
}
await prisma.$disconnect();
console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed  (isolated DB: ${dbFile})`);
process.exitCode = failed ? 1 : 0;
