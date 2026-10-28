/**
 * Internal: find approved submissions whose reward didn't go through and try
 * again. For us (the Social Wall team), not for merchants.
 *
 * Store credit failures marked "UNCERTAIN" (the request may have reached
 * Shopify) are resolved by first checking the customer's store credit history
 * (read_store_credit_accounts): found → marked delivered; not found → credited.
 * If that check isn't possible, they're left alone — never credited twice.
 *
 *   npm run rewards:retry -- --dry-run          # list problem rewards, change nothing
 *   npm run rewards:retry                       # retry all of them
 *   npm run rewards:retry -- --shop my-store.myshopify.com
 *   npm run rewards:retry -- --submission <submissionId>
 *
 * "Problem" = submission APPROVED and its reward is missing, CREATED (never
 * delivered — e.g. the old subscriptionId bug) or FAILED — or the reward was
 * delivered but the customer's "approved + your reward" email never went out.
 *
 * Discount-code rewards need Shopify Admin access: the shop's offline session
 * token is used. If it has expired, open the app once in that shop's admin
 * (refreshes the token) and re-run. If the token lacks write_discounts,
 * re-approve the app's permissions first.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
(globalThis as any).prismaGlobal = prisma; // app code shares this client

const { fulfillReward } = await import("../app/utils/rewards.server");

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = flag("dry-run");
const onlyShop = opt("shop");
const onlySubmission = opt("submission");
const API_VERSION = "2025-01";

type AdminClient = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

async function adminFor(shopDomain: string): Promise<{ admin?: AdminClient; problem?: string; scopes: string[] }> {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session) return { problem: "no offline session (app not installed?)", scopes: [] };
  const scopes = (session.scope || "").split(",").map((s) => s.trim());
  if (session.expires && session.expires.getTime() < Date.now()) {
    return { problem: `offline token expired ${session.expires.toISOString()} — open the app in this shop's admin, then re-run`, scopes };
  }
  const admin: AdminClient = {
    graphql: (query, o) =>
      fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
        body: JSON.stringify({ query, variables: o?.variables ?? {} }),
      }),
  };
  return { admin, scopes };
}

const problems = await prisma.submission.findMany({
  where: {
    status: "APPROVED",
    ...(onlySubmission ? { id: onlySubmission } : {}),
    ...(onlyShop ? { campaign: { shop: { shopDomain: onlyShop } } } : {}),
    OR: [
      { reward: null },
      { reward: { status: { in: ["CREATED", "FAILED"] } } },
      // Delivered but never emailed (skip unusable rows: code rewards with no code, customers with no email)
      {
        reward: {
          status: "APPLIED",
          OR: [
            { rewardType: { in: ["SUBSCRIPTION_DISCOUNT", "NONE", "STORE_CREDIT"] } },
            { discountCode: { not: null } },
          ],
        },
        customer: { email: { not: "" } }, // narrowed per submission below
      },
    ],
  },
  include: {
    campaign: { include: { shop: true } },
    customer: { select: { email: true, shopifyCustomerId: true } },
    reward: true,
  },
  orderBy: { createdAt: "asc" },
});

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
// The "no approval email" filter above is per customer; narrow it to this submission
const realSendingOn = !!process.env.RESEND_API_KEY;
const emailed = new Set(
  (await prisma.emailLog.findMany({ where: { type: "SUBMISSION_APPROVED" }, select: { metadata: true } }))
    .map((l) => { try { const m = JSON.parse(l.metadata); return realSendingOn && m.provider === "preview" ? "" : (m.submissionId as string); } catch { return ""; } }),
);
for (let i = problems.length - 1; i >= 0; i--) {
  const p = problems[i];
  if (p.reward?.status === "APPLIED" && emailed.has(p.id)) problems.splice(i, 1);
}
console.log(`\n${problems.length} approved submission(s) with an undelivered reward or missing email${dryRun ? " (dry run — nothing will change)" : ""}\n`);
if (!problems.length) {
  await prisma.$disconnect();
  process.exit(0);
}

const byShop = new Map<string, typeof problems>();
for (const p of problems) {
  const k = p.campaign.shop.shopDomain;
  byShop.set(k, [...(byShop.get(k) || []), p]);
}

const tally = { APPLIED: 0, FAILED: 0, skipped: 0, emailed: 0, emailFailed: 0 };
for (const [shopDomain, subs] of byShop) {
  const shop = subs[0].campaign.shop;
  const needsAdmin = subs.some((s) => s.campaign.rewardType === "DISCOUNT_CODE" || s.campaign.rewardType === "STORE_CREDIT");
  const access = needsAdmin ? await adminFor(shopDomain) : { scopes: [] as string[] };
  console.log(`── ${shopDomain}  (provider: ${shop.subscriptionProvider}${shop.providerConnected ? "" : ", not connected"})`);
  if (needsAdmin && access.problem) console.log(`   ⚠ Shopify admin: ${access.problem}`);
  for (const [type, scope] of [["DISCOUNT_CODE", "write_discounts"], ["STORE_CREDIT", "write_store_credit_account_transactions"]] as const) {
    if (needsAdmin && !access.problem && subs.some((s) => s.campaign.rewardType === type) && !access.scopes.includes(scope)) {
      console.log(`   ⚠ Shopify admin: token scopes are [${access.scopes.join(", ")}] — missing ${scope}; re-approve the app's permissions`);
    }
  }

  for (const s of subs) {
    const who = pad(s.customer.email || s.customer.shopifyCustomerId || s.customerId, 34);
    const kind = { DISCOUNT_CODE: "code", STORE_CREDIT: "credit", NONE: "featured", SUBSCRIPTION_DISCOUNT: "subscription" }[s.campaign.rewardType] ?? s.campaign.rewardType;
    const what = pad(`${kind} · ${s.campaign.title}`, 40);
    const before = s.reward
      ? s.reward.status === "APPLIED"
        ? "APPLIED, email not sent"
        : `${s.reward.status}${s.reward.failureReason ? ` (${s.reward.failureReason})` : ""}`
      : "no reward row";
    if (dryRun) {
      console.log(`   ${who} ${what} ${before}`);
      tally.skipped++;
      continue;
    }
    let line: string;
    try {
      const out = await fulfillReward({
        submissionId: s.id,
        shop: {
          id: shop.id,
          subscriptionProvider: shop.subscriptionProvider,
          providerApiKey: shop.providerApiKey,
          providerConnected: shop.providerConnected,
        },
        admin: (access as { admin?: AdminClient }).admin,
      });
      tally[out.status]++;
      if (out.email?.status === "sent") tally.emailed++;
      if (out.email?.status === "failed") tally.emailFailed++;
      const mail = out.email ? `, email ${out.email.status}${out.email.status === "failed" ? ` (${out.email.detail})` : ""}` : "";
      line =
        out.status === "APPLIED"
          ? `✓ APPLIED${out.discountCode ? ` ${out.discountCode}` : ""}${mail}`
          : `✗ FAILED — ${out.reason}`;
    } catch (err) {
      tally.FAILED++;
      line = `✗ ERROR — ${(err as Error).message}`;
    }
    console.log(`   ${who} ${what} ${line}   [was: ${before}]`);
  }
  console.log("");
}

if (dryRun) console.log(`Dry run: ${tally.skipped} reward(s) would be retried.`);
else
  console.log(
    `Done: ${tally.APPLIED} reward(s) delivered, ${tally.FAILED} still failing; ` +
      `${tally.emailed} email(s) sent${tally.emailFailed ? `, ${tally.emailFailed} email(s) failed` : ""}.`,
  );
await prisma.$disconnect();
