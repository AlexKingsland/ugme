/**
 * Provider parity harness.
 *
 * Runs a fixed set of scenarios through the reward/subscription code of a
 * given source tree with a mocked Recharge/Shopify API and an isolated copy
 * of the dev database, and prints a JSON record of everything observable:
 * provider API calls (method, path, body), return values, and DB effects.
 *
 *   node --env-file=.env --import tsx scripts/parity/provider-parity.ts --root <src-root> --mode legacy|adapter > out.json
 *
 * `--mode legacy` drives the pre-adapter code paths (recharge.server functions
 * as the old call sites used them); `--mode adapter` drives the same flows
 * through app/utils/providers. Diff the two outputs to prove parity.
 *
 * Regression check against the recorded pre-adapter behaviour:
 *   npm run test:providers
 * (= --mode adapter --compare scripts/parity/provider-parity.snapshot.json)
 * When behaviour changes ON PURPOSE, re-record the snapshot:
 *   npm run test:providers -- --update
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const root = resolve(arg("root") || ".");
const mode = (arg("mode") || "adapter") as "legacy" | "adapter";
const imp = (p: string) => import(pathToFileURL(join(root, p)).href);

process.env.RECHARGE_API_TOKEN = "env-token";
// Silence app logging so output is just the JSON record
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const out = (s: string) => process.stdout.write(s);

// ── isolated database ───────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "ugme-parity-"));
const dbFile = join(dir, "parity.sqlite");
copyFileSync(resolve("prisma/dev.sqlite"), dbFile);
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
// Emails: always preview mode, written to the temp dir (never really sent)
delete process.env.RESEND_API_KEY;
process.env.EMAIL_PREVIEW_DIR = join(dir, "emails");
(globalThis as any).prismaGlobal = prisma;

// ── mocked provider APIs ────────────────────────────────────────
type Call = { method: string; path: string; token?: string | null; body?: unknown };
let calls: Call[] = [];
let failures: Record<string, number> = {}; // "METHOD /path-prefix" → status
let rechargeData: {
  customers: Record<string, { id: number }>;
  subscriptionsByCustomer: Record<number, Array<{ id: number; address_id: number; external_product_id: { ecommerce: string } }>>;
  subscriptions: Record<number, { id: number; address_id: number }>;
} = { customers: {}, subscriptionsByCustomer: {}, subscriptions: {} };
let nextDiscountId = 9000;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

(globalThis as any).fetch = async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method || "GET").toUpperCase();
  const path = url.pathname + url.search;
  const headers = (init?.headers || {}) as Record<string, string>;
  calls.push({ method, path, token: headers["X-Recharge-Access-Token"] ?? null, body: init?.body ? scrubDates(JSON.parse(String(init.body))) : undefined });
  for (const [k, status] of Object.entries(failures)) {
    const [m, p] = k.split(" ");
    if (m === method && path.startsWith(p)) return jsonRes(status, { error: "mock failure" });
  }
  if (method === "GET" && url.pathname === "/customers") {
    const c = rechargeData.customers[url.searchParams.get("external_customer_id") || ""];
    return jsonRes(200, { customers: c ? [c] : [] });
  }
  if (method === "GET" && url.pathname === "/subscriptions") {
    if (url.searchParams.get("external_product_id")) {
      const pid = url.searchParams.get("external_product_id");
      const all = Object.values(rechargeData.subscriptionsByCustomer).flat().filter((s) => s.external_product_id.ecommerce === pid);
      return jsonRes(200, { subscriptions: all.slice(0, 1) });
    }
    return jsonRes(200, { subscriptions: rechargeData.subscriptionsByCustomer[Number(url.searchParams.get("customer_id"))] || [] });
  }
  if (method === "GET" && url.pathname.startsWith("/subscriptions/")) {
    const s = rechargeData.subscriptions[Number(url.pathname.split("/")[2])];
    return s ? jsonRes(200, { subscription: s }) : jsonRes(404, {});
  }
  if (method === "POST" && url.pathname === "/discounts") {
    const b = JSON.parse(String(init?.body));
    return jsonRes(200, { discount: { id: nextDiscountId++, code: b.code, value: b.value, value_type: b.value_type, status: "enabled" } });
  }
  if (method === "PUT" && url.pathname.startsWith("/addresses/")) {
    return jsonRes(200, { address: { id: Number(url.pathname.split("/")[2]), customer_id: 1, discounts: [] } });
  }
  if (method === "DELETE" && url.pathname.startsWith("/discounts/")) return new Response(null, { status: 204 });
  return jsonRes(404, { error: "unmocked " + method + " " + path });
};

const scrubDates = (v: unknown): unknown =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
    ? "<date>"
    : Array.isArray(v)
      ? v.map(scrubDates)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDates(x)]))
        : v;

let sellingPlanEdges = 0;
let existingShopifyCodes = new Set<string>();
const admin = {
  graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    const op = query.includes("sellingPlanGroups")
      ? "sellingPlanGroups"
      : query.includes("discountCodeBasicCreate")
        ? "discountCodeBasicCreate"
        : query.includes("codeDiscountNodeByCode")
          ? "codeDiscountNodeByCode"
          : "codeDiscountNodes";
    calls.push({ method: "GRAPHQL", path: op, body: scrubDates(opts?.variables) });
    if (failures[`GRAPHQL ${op}`]) {
      return jsonRes(200, { data: { [op]: { codeDiscountNode: null, userErrors: [{ field: ["basicCodeDiscount"], message: "Mock rejection", code: "INVALID" }] } } });
    }
    if (op === "codeDiscountNodeByCode") {
      const code = String(opts?.variables?.code);
      return jsonRes(200, { data: { codeDiscountNodeByCode: existingShopifyCodes.has(code) ? { id: "gid://shopify/DiscountCodeNode/existing" } : null } });
    }
    if (op === "discountCodeBasicCreate") {
      return jsonRes(200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, userErrors: [] } } });
    }
    return jsonRes(200, { data: { product: { sellingPlanGroups: { edges: Array.from({ length: sellingPlanEdges }, (_, i) => ({ node: { id: `sp${i}`, name: "Plan" } })) } } } });
  },
};

// ── fixtures ────────────────────────────────────────────────────
const SHOP_R = "parity-shop-recharge";
const SHOP_N = "parity-shop-native";
async function resetFixtures() {
  await prisma.emailLog.deleteMany({ where: { customer: { shopId: { in: [SHOP_R, SHOP_N] } } } });
  await prisma.reward.deleteMany({ where: { submission: { campaign: { shopId: { in: [SHOP_R, SHOP_N] } } } } });
  await prisma.submission.deleteMany({ where: { campaign: { shopId: { in: [SHOP_R, SHOP_N] } } } });
  await prisma.customer.deleteMany({ where: { shopId: { in: [SHOP_R, SHOP_N] } } });
  await prisma.campaign.deleteMany({ where: { shopId: { in: [SHOP_R, SHOP_N] } } });
  await prisma.shop.deleteMany({ where: { id: { in: [SHOP_R, SHOP_N] } } });
  await prisma.shop.create({ data: { id: SHOP_R, shopDomain: "parity-r.myshopify.com", accessToken: "x", subscriptionProvider: "RECHARGE", providerConnected: true, providerApiKey: "shop-token" } });
  await prisma.shop.create({ data: { id: SHOP_N, shopDomain: "parity-n.myshopify.com", accessToken: "x", subscriptionProvider: "SHOPIFY_NATIVE", providerConnected: true } });
}

async function makeSubmission(opts: {
  shopId: string; id: string; discountType?: "FREE" | "PERCENTAGE" | "FIXED_AMOUNT"; discountValue?: number; cycles?: number;
  subscriptionId?: string | null; shopifyCustomerId?: string | null; customerId?: string;
  rewardType?: "DISCOUNT_CODE" | "SUBSCRIPTION_DISCOUNT"; codeType?: "PERCENTAGE" | "FIXED_AMOUNT"; codeAmount?: number | null;
  codeExpiryDays?: number | null; codeMinOrder?: number | null; approved?: boolean;
}) {
  const campaignId = `${opts.id}-camp`;
  await prisma.campaign.create({
    data: {
      id: campaignId, shopId: opts.shopId, title: "Parity Campaign!", moment: "m", status: "ACTIVE",
      productId: "gid://shopify/Product/4242", productTitle: "Parity Product", rewardType: opts.rewardType || "SUBSCRIPTION_DISCOUNT",
      discountType: opts.discountType || "PERCENTAGE", discountValue: opts.discountValue ?? 20, rewardCycles: opts.cycles ?? 3,
      discountCodeType: opts.codeType ?? null, discountCodeAmount: opts.codeAmount ?? null,
      discountCodeExpiryDays: opts.codeExpiryDays ?? null, discountCodeMinOrder: opts.codeMinOrder ?? null,
    },
  });
  const customerId = opts.customerId || `${opts.id}-cust`;
  await prisma.customer.upsert({
    where: { id: customerId },
    update: {},
    create: { id: customerId, shopId: opts.shopId, email: `${customerId}@x.com`, shopifyCustomerId: opts.shopifyCustomerId === undefined ? "777" : opts.shopifyCustomerId },
  });
  await prisma.submission.create({
    data: {
      id: opts.id, campaignId, customerId, contentUrl: "r2://x/y.mp4",
      subscriptionId: opts.subscriptionId === undefined ? "5001" : opts.subscriptionId,
      status: opts.approved ? "APPROVED" : "PENDING",
    },
  });
  return { campaignId, customerId };
}

async function shopRow(id: string) {
  return prisma.shop.findUniqueOrThrow({ where: { id }, select: { id: true, subscriptionProvider: true, providerApiKey: true, providerConnected: true } });
}

const normRewards = (rows: any[]) =>
  rows.map((r) => ({
    submissionId: r.submissionId, rewardType: r.rewardType, status: r.status, applied: !!r.appliedAt,
    externalDiscountId: r.externalDiscountId, rechargeChargeId: r.rechargeChargeId, rechargeSubscriptionId: r.rechargeSubscriptionId,
    discountCode: r.discountCode, discountProvider: r.discountProvider, cycles: r.cycles,
    failureReason: r.failureReason ?? null, attemptCount: r.attemptCount ?? 0, expires: !!r.expiresAt,
  }));

// ── scenarios ───────────────────────────────────────────────────
const record: Record<string, unknown> = {};

async function scenario(name: string, setup: () => Promise<void>, run: () => Promise<unknown>) {
  await resetFixtures();
  calls = []; failures = {}; nextDiscountId = 9000; sellingPlanEdges = 0; existingShopifyCodes = new Set();
  rechargeData = {
    customers: { "777": { id: 31 } },
    subscriptionsByCustomer: { 31: [{ id: 5001, address_id: 6001, external_product_id: { ecommerce: "4242" } }, { id: 5002, address_id: 6001, external_product_id: { ecommerce: "9999" } }] },
    subscriptions: { 5001: { id: 5001, address_id: 6001 } },
  };
  await setup();
  calls = [];
  let result: unknown;
  try {
    result = await run();
  } catch (e) {
    result = { threw: String((e as Error).message).slice(0, 120) };
  }
  const rewards = await prisma.reward.findMany({ where: { submission: { campaign: { shopId: { in: [SHOP_R, SHOP_N] } } } }, orderBy: { submissionId: "asc" } });
  const subs = await prisma.submission.findMany({ where: { campaign: { shopId: { in: [SHOP_R, SHOP_N] } } }, select: { id: true, status: true, subscriptionId: true }, orderBy: { id: "asc" } });
  // Volatile email details (preview file path) → keep only the status
  if (result && typeof result === "object" && (result as any).email) {
    (result as any).email = { status: (result as any).email.status };
  }
  // Generated IDs differ between runs — keep only whether they were set
  if (result && typeof result === "object" && "replacedRewardId" in (result as any)) {
    (result as any).replacedRewardId = (result as any).replacedRewardId ? "set" : undefined;
  }
  const emails = await prisma.emailLog.findMany({
    where: { customer: { shopId: { in: [SHOP_R, SHOP_N] } } },
    select: { type: true, metadata: true },
  });
  record[name] = {
    result, calls, rewards: normRewards(rewards), submissions: subs,
    emails: emails.map((e) => `${e.type}:${JSON.parse(e.metadata).submissionId}`).sort(),
  };
}

const approval = await imp("app/utils/approval.server.ts");
const gating = await imp("app/utils/reward-gating.server.ts");
const recharge = await imp("app/utils/recharge.server.ts");
const providers = mode === "adapter" ? await imp("app/utils/providers/index.ts") : null;

// Approval — the core reward path
const approve = async (subId: string, shopId: string) => approval.approveSubmission({ submissionId: subId, shop: await shopRow(shopId), admin });

await scenario("approve/recharge-percentage", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1" }); }, () => approve("s1", SHOP_R));
await scenario("approve/recharge-free", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1", discountType: "FREE", discountValue: 0, cycles: 1 }); }, () => approve("s1", SHOP_R));
await scenario("approve/recharge-fixed", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1", discountType: "FIXED_AMOUNT", discountValue: 7.5, cycles: 6 }); }, () => approve("s1", SHOP_R));
await scenario("approve/recharge-replaces-existing", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s0", customerId: "c-shared" });
  await prisma.reward.create({ data: { submissionId: "s0", customerId: "c-shared", status: "APPLIED", appliedAt: new Date(), discountProvider: "RECHARGE", rewardType: "SUBSCRIPTION_DISCOUNT", externalDiscountId: "555", rechargeChargeId: "6001", cycles: 3 } });
  await makeSubmission({ shopId: SHOP_R, id: "s1", customerId: "c-shared" });
}, () => approve("s1", SHOP_R));
await scenario("approve/recharge-replace-clear-fails", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s0", customerId: "c-shared" });
  await prisma.reward.create({ data: { submissionId: "s0", customerId: "c-shared", status: "APPLIED", appliedAt: new Date(), discountProvider: "RECHARGE", rewardType: "SUBSCRIPTION_DISCOUNT", externalDiscountId: "555", rechargeChargeId: "6001", cycles: 3 } });
  await makeSubmission({ shopId: SHOP_R, id: "s1", customerId: "c-shared" });
  failures = { "DELETE /discounts/555": 500 };
}, async () => { failures = { "DELETE /discounts/555": 500 }; return approve("s1", SHOP_R); });
await scenario("approve/recharge-create-discount-fails", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1" }); }, async () => { failures = { "POST /discounts": 422 }; return approve("s1", SHOP_R); });
await scenario("approve/recharge-apply-address-fails", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1" }); }, async () => { failures = { "PUT /addresses/": 500 }; return approve("s1", SHOP_R); });
await scenario("approve/recharge-customer-missing", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1", shopifyCustomerId: "888" }); }, () => approve("s1", SHOP_R));
await scenario("approve/recharge-no-subscription-id", async () => { await makeSubmission({ shopId: SHOP_R, id: "s1", subscriptionId: null }); }, () => approve("s1", SHOP_R));
await scenario("approve/recharge-not-connected", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1" });
  await prisma.shop.update({ where: { id: SHOP_R }, data: { providerConnected: false } });
}, () => approve("s1", SHOP_R));
await scenario("approve/native", async () => { await makeSubmission({ shopId: SHOP_N, id: "s1" }); }, () => approve("s1", SHOP_N));

// Subscription re-validation at approval time
await scenario("approve/recharge-subscription-cancelled", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1" });
  rechargeData.subscriptionsByCustomer[31] = [{ id: 5002, address_id: 6001, external_product_id: { ecommerce: "9999" } }];
}, () => approve("s1", SHOP_R));
await scenario("approve/recharge-subscription-swapped", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", subscriptionId: "5000" });
}, () => approve("s1", SHOP_R));

// Discount-code campaigns
const codeCampaign = { rewardType: "DISCOUNT_CODE" as const, subscriptionId: null };
await scenario("approve/code-percentage-expiry-min", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeType: "PERCENTAGE", codeAmount: 20, codeExpiryDays: 30, codeMinOrder: 50 });
}, () => approve("s1", SHOP_R));
await scenario("approve/code-fixed", async () => {
  await makeSubmission({ shopId: SHOP_N, id: "s1", ...codeCampaign, codeType: "FIXED_AMOUNT", codeAmount: 6 });
}, () => approve("s1", SHOP_N));
await scenario("approve/code-already-on-shopify-reused", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeType: "FIXED_AMOUNT", codeAmount: 6 });
  existingShopifyCodes.add("UGME-PARITYCAMP-S1");
}, () => approve("s1", SHOP_R));
await scenario("approve/code-no-amount", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeAmount: null });
}, () => approve("s1", SHOP_R));
await scenario("approve/code-shopify-rejects", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeType: "PERCENTAGE", codeAmount: 10 });
}, async () => { failures = { "GRAPHQL discountCodeBasicCreate": 1 }; return approve("s1", SHOP_R); });
await scenario("approve/code-no-admin-client", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeType: "PERCENTAGE", codeAmount: 10 });
}, async () => approval.approveSubmission({ submissionId: "s1", shop: await shopRow(SHOP_R) }));

// Retry path (scripts/retry-rewards.ts uses fulfillReward)
await scenario("retry/failed-code-then-succeeds", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeType: "PERCENTAGE", codeAmount: 10 });
  failures = { "GRAPHQL discountCodeBasicCreate": 1 };
  await approve("s1", SHOP_R);
  failures = {};
}, async () => {
  const rewards = await imp("app/utils/rewards.server.ts");
  return rewards.fulfillReward({ submissionId: "s1", shop: await shopRow(SHOP_R), admin });
});
await scenario("retry/already-applied-is-noop", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1" });
  await approve("s1", SHOP_R);
}, async () => {
  const rewards = await imp("app/utils/rewards.server.ts");
  return rewards.fulfillReward({ submissionId: "s1", shop: await shopRow(SHOP_R), admin });
});
await scenario("email/sent-once-across-retries", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeType: "PERCENTAGE", codeAmount: 15 });
  await approve("s1", SHOP_R);
}, async () => {
  const rewards = await imp("app/utils/rewards.server.ts");
  const again1 = await rewards.fulfillReward({ submissionId: "s1", shop: await shopRow(SHOP_R), admin });
  const again2 = await rewards.fulfillReward({ submissionId: "s1", shop: await shopRow(SHOP_R), admin });
  return [again1.email?.status, again2.email?.status];
});
await scenario("email/not-sent-when-reward-fails", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s1", ...codeCampaign, codeAmount: null });
}, () => approve("s1", SHOP_R));
await scenario("gating/ignores-code-rewards", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s0", customerId: "c-shared", ...codeCampaign, codeType: "PERCENTAGE", codeAmount: 10 });
  await prisma.reward.create({ data: { submissionId: "s0", customerId: "c-shared", rewardType: "DISCOUNT_CODE", status: "APPLIED", appliedAt: new Date("2030-01-01"), discountProvider: "RECHARGE", externalDiscountId: "gid://shopify/DiscountCodeNode/1", cycles: 1 } });
}, async () => ({
  gating: await gating.checkRewardGating({ customerId: "c-shared", shopId: SHOP_R, subscriptionProvider: "RECHARGE" }),
  replace: await gating.findActiveRewardToReplace({ customerId: "c-shared", shopId: SHOP_R, subscriptionProvider: "RECHARGE" }),
}));

// Reward gating (single-discount providers)
await scenario("gating/single-discount-flags", async () => {}, async () => ({
  RECHARGE: gating.isSingleDiscountProvider("RECHARGE"),
  SHOPIFY_NATIVE: gating.isSingleDiscountProvider("SHOPIFY_NATIVE"),
}));
await scenario("gating/recharge-active-reward", async () => {
  await makeSubmission({ shopId: SHOP_R, id: "s0", customerId: "c-shared" });
  await prisma.reward.create({ data: { submissionId: "s0", customerId: "c-shared", status: "APPLIED", appliedAt: new Date("2030-01-01"), discountProvider: "RECHARGE", rewardType: "SUBSCRIPTION_DISCOUNT", externalDiscountId: "555", rechargeChargeId: "6001", cycles: 3 } });
}, async () => {
  const g = await gating.checkRewardGating({ customerId: "c-shared", shopId: SHOP_R, subscriptionProvider: "RECHARGE" });
  const r = await gating.findActiveRewardToReplace({ customerId: "c-shared", shopId: SHOP_R, subscriptionProvider: "RECHARGE" });
  return { gating: { ...g, estimatedExpiry: g.estimatedExpiry ? "set" : undefined }, replace: r && { ...r, rewardId: "id" } };
});
await scenario("gating/native", async () => {
  await makeSubmission({ shopId: SHOP_N, id: "s0", customerId: "c-shared" });
  await prisma.reward.create({ data: { submissionId: "s0", customerId: "c-shared", status: "APPLIED", appliedAt: new Date("2030-01-01"), discountProvider: "SHOPIFY_NATIVE", cycles: 3 } });
}, async () => ({
  gating: await gating.checkRewardGating({ customerId: "c-shared", shopId: SHOP_N, subscriptionProvider: "SHOPIFY_NATIVE" }),
  replace: await gating.findActiveRewardToReplace({ customerId: "c-shared", shopId: SHOP_N, subscriptionProvider: "SHOPIFY_NATIVE" }),
}));

// Storefront subscriber check (4 call sites in api.proxy.$.tsx share this logic).
// Legacy: the inline composition the proxy used; adapter: checkSubscriber.
const shouldCheck = (shop: { subscriptionProvider: string; providerConnected: boolean }) =>
  mode === "legacy"
    ? shop.providerConnected && shop.subscriptionProvider === "RECHARGE"
    : shop.providerConnected && providers.getProviderAdapter(shop.subscriptionProvider).capabilities.verifiesSubscribers;
const subscriberCheck = async (shopId: string, customerId: string) => {
  const shop = await shopRow(shopId);
  if (!shouldCheck(shop)) return "skipped";
  if (mode === "legacy") {
    const rc = await recharge.getRechargeCustomer(customerId, shop.providerApiKey || undefined);
    if (!rc) return { status: "no_customer" };
    const subs = await recharge.getActiveSubscriptionsForProduct(rc.id, "gid://shopify/Product/4242", shop.providerApiKey || undefined);
    if (subs.length === 0) return { status: "no_matching_subscription" };
    return { status: "eligible", subscriptionIds: subs.map((s: any) => String(s.id)) };
  }
  return providers.getProviderAdapter(shop.subscriptionProvider).checkSubscriber({ apiKey: shop.providerApiKey }, customerId, "gid://shopify/Product/4242");
};
await scenario("subscriber/eligible", async () => {}, () => subscriberCheck(SHOP_R, "777"));
await scenario("subscriber/no-customer", async () => {}, () => subscriberCheck(SHOP_R, "888"));
await scenario("subscriber/no-matching-subscription", async () => {
  rechargeData.subscriptionsByCustomer[31] = [{ id: 5002, address_id: 6001, external_product_id: { ecommerce: "9999" } }];
}, () => subscriberCheck(SHOP_R, "777"));
await scenario("subscriber/api-error", async () => {}, async () => { failures = { "GET /customers": 500 }; return subscriberCheck(SHOP_R, "777"); });
await scenario("subscriber/native-skipped", async () => {}, () => subscriberCheck(SHOP_N, "777"));

// Campaign creation: "does this product have subscriptions?"
// Legacy = the old route body verbatim; adapter = productHasSubscriptions.
const legacyHasSellingPlans = async (shop: { subscriptionProvider: string; providerConnected: boolean; providerApiKey: string | null }, productId: string) => {
  if (!shop?.providerConnected) return false;
  try {
    if (shop.subscriptionProvider === "RECHARGE" && shop.providerApiKey) {
      const numericId = productId.replace(/^gid:\/\/shopify\/Product\//, "");
      const rechargeRes = await fetch(`https://api.rechargeapps.com/subscriptions?external_product_id=${numericId}&status=active&limit=1`, { headers: { "X-Recharge-Access-Token": shop.providerApiKey, "X-Recharge-Version": "2021-11" } });
      if (!rechargeRes.ok) return false;
      const rechargeData: any = await rechargeRes.json();
      return (rechargeData?.subscriptions ?? []).length > 0;
    }
    const response = await admin.graphql(`#graphql query checkSellingPlans($productId: ID!) { product(id: $productId) { sellingPlanGroups(first: 1) { edges { node { id name } } } } }`, { variables: { productId } });
    const data: any = await response.json();
    return (data?.data?.product?.sellingPlanGroups?.edges ?? []).length > 0;
  } catch {
    return false;
  }
};
const hasPlans = async (shopId: string, productId: string) => {
  const shop = await shopRow(shopId);
  if (mode === "legacy") return legacyHasSellingPlans(shop, productId);
  if (!shop?.providerConnected) return false;
  try {
    return await providers.getProviderAdapter(shop.subscriptionProvider).productHasSubscriptions({ apiKey: shop.providerApiKey, admin }, productId);
  } catch {
    return false;
  }
};
await scenario("plans/recharge-has", async () => {}, () => hasPlans(SHOP_R, "gid://shopify/Product/4242"));
await scenario("plans/recharge-none", async () => {}, () => hasPlans(SHOP_R, "gid://shopify/Product/1"));
await scenario("plans/recharge-api-error", async () => {}, async () => { failures = { "GET /subscriptions": 500 }; return hasPlans(SHOP_R, "gid://shopify/Product/4242"); });
await scenario("plans/recharge-no-token-falls-back-to-shopify", async () => {
  await prisma.shop.update({ where: { id: SHOP_R }, data: { providerApiKey: null } });
}, async () => { sellingPlanEdges = 1; return hasPlans(SHOP_R, "gid://shopify/Product/4242"); });
await scenario("plans/native-has", async () => {}, async () => { sellingPlanEdges = 1; return hasPlans(SHOP_N, "gid://shopify/Product/4242"); });
await scenario("plans/native-none", async () => {}, async () => { sellingPlanEdges = 0; return hasPlans(SHOP_N, "gid://shopify/Product/4242"); });
await scenario("plans/not-connected", async () => {
  await prisma.shop.update({ where: { id: SHOP_N }, data: { providerConnected: false } });
}, () => hasPlans(SHOP_N, "gid://shopify/Product/4242"));

await prisma.$disconnect();
const json = JSON.stringify(record, null, 2) + "\n";
const compareWith = arg("compare");
if (!compareWith) {
  out(json);
} else {
  const { readFileSync, writeFileSync } = await import("node:fs");
  if (process.argv.includes("--update")) {
    writeFileSync(compareWith, json);
    out(`Snapshot updated: ${compareWith} (${Object.keys(record).length} scenarios)\n`);
  } else {
    const expected = JSON.parse(readFileSync(compareWith, "utf8"));
    const actual = JSON.parse(json);
    const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
    const changed = names.filter((n) => JSON.stringify(expected[n]) !== JSON.stringify(actual[n]));
    if (changed.length) {
      out(`✗ ${changed.length}/${names.length} provider scenarios differ from the snapshot:\n`);
      for (const n of changed) out(`  - ${n}\n`);
      out("Run with --root/--mode and diff against the snapshot to see details.\n");
      process.exitCode = 1;
    } else {
      out(`✓ All ${names.length} provider scenarios match the snapshot.\n`);
    }
  }
}
