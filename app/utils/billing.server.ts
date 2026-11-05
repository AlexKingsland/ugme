/**
 * Shopify billing is the source of truth for a store's plan.
 *
 * The app never sets a paid plan when the merchant clicks "Upgrade" — only after
 * Shopify reports the subscription ACTIVE (merchant approved the charge). It re-reads
 * the store's active subscription when the merchant returns from Shopify's approval
 * page, on the billing page, periodically from the admin, and on the
 * app_subscriptions/update webhook.
 */
import prisma from "../db.server";
import { PLAN_DEFINITIONS, type PlanTierKey } from "./plans";

type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

/** Subscription names are "Social Wall <Plan name>" (see the billing page). */
export function subscriptionName(plan: { name: string }) {
  return `Social Wall ${plan.name}`;
}

export function planKeyFromSubscriptionName(name: string | null | undefined): PlanTierKey | null {
  const n = String(name || "").trim().toLowerCase();
  for (const p of Object.values(PLAN_DEFINITIONS)) {
    if (p.priceMonthly > 0 && subscriptionName(p).toLowerCase() === n) return p.key;
  }
  // Subscriptions created before the Starter → Standard rename
  if (n === "social wall starter") return "STARTER";
  return null;
}

/**
 * Read the store's active subscription from Shopify and store the matching plan.
 * Returns the plan, or null if Shopify couldn't be asked (the stored plan is kept).
 * Stores on ENTERPRISE (assigned by hand, no Shopify subscription) are left alone.
 */
export async function syncPlanFromShopify(graphql: Graphql, shopDomain: string): Promise<PlanTierKey | null> {
  let subs: { id: string; name: string; status: string }[];
  try {
    const res = await graphql(`#graphql
      query SocialWallActiveSubscriptions {
        currentAppInstallation { activeSubscriptions { id name status } }
      }`);
    const body: any = await res.json();
    subs = body?.data?.currentAppInstallation?.activeSubscriptions;
    if (!Array.isArray(subs)) return null;
  } catch (err) {
    console.warn(`[billing] couldn't read subscriptions for ${shopDomain}:`, err);
    return null;
  }

  const active = subs.find((s) => s.status === "ACTIVE" && planKeyFromSubscriptionName(s.name));
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { planTier: true, shopifySubscriptionId: true } });
  if (!shop) return null;
  if (shop.planTier === "ENTERPRISE" && !active) return "ENTERPRISE";

  const planTier: PlanTierKey = active ? planKeyFromSubscriptionName(active.name)! : "FREE";
  const subscriptionId = active?.id ?? null;
  if (shop.planTier !== planTier || shop.shopifySubscriptionId !== subscriptionId) {
    await prisma.shop.update({
      where: { shopDomain },
      data: { planTier, shopifySubscriptionId: subscriptionId, planActivatedAt: new Date() },
    });
    console.log(`[billing] ${shopDomain}: plan ${shop.planTier} → ${planTier}`);
  }
  return planTier;
}

const lastSync = new Map<string, number>();

/** Fire-and-forget from the admin layout; at most every 5 minutes per store per process. */
export function maybeSyncPlan(graphql: Graphql, shopDomain: string) {
  const last = lastSync.get(shopDomain) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  lastSync.set(shopDomain, Date.now());
  syncPlanFromShopify(graphql, shopDomain).catch(() => {});
}
