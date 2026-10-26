/**
 * Wall campaigns — the merchant-facing name for a Campaign.
 *
 * A wall campaign collects content from VERIFIED BUYERS only: a customer can
 * submit when they have an order containing one of the wall's products (or
 * any order, for an "all products" wall). The products they bought are saved
 * on the submission and shown as product cards on the wall.
 */
import { money } from "./rewards/presenters";

export type WallProduct = {
  id: string; // gid://shopify/Product/123
  title: string;
  handle: string | null;
  imageUrl: string | null;
};

export type ProductScope = "SPECIFIC" | "ALL";

/** Max product cards shown on one post. */
export const MAX_POST_PRODUCTS = 3;

export function parseProducts(json: string | null | undefined): WallProduct[] {
  try {
    const v = JSON.parse(json || "[]");
    if (!Array.isArray(v)) return [];
    return v
      .filter((p) => p && typeof p.id === "string")
      .map((p) => ({
        id: String(p.id),
        title: String(p.title || ""),
        handle: p.handle ? String(p.handle) : null,
        imageUrl: p.imageUrl ? String(p.imageUrl) : null,
      }));
  } catch {
    return [];
  }
}

// ── Verified-buyer check ────────────────────────────────────────

export type BuyerCheck =
  | { status: "eligible"; products: WallProduct[] }
  | { status: "not_buyer" }
  | { status: "error"; reason: string };

export type OrderNode = {
  cancelledAt: string | null;
  lineItems: { nodes: { product: { id: string; title: string; handle: string; featuredMedia?: { preview?: { image?: { url?: string } } } } | null }[] };
};

/** Pure part of the check — exported for tests. Orders must be newest first. */
export function matchPurchasedProducts(
  orders: OrderNode[],
  scope: ProductScope,
  wallProducts: WallProduct[],
): BuyerCheck {
  const wanted = new Set(wallProducts.map((p) => p.id));
  const found: WallProduct[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    if (order.cancelledAt) continue;
    for (const li of order.lineItems?.nodes ?? []) {
      const p = li.product;
      if (!p || seen.has(p.id)) continue;
      if (scope === "SPECIFIC" && !wanted.has(p.id)) continue;
      seen.add(p.id);
      found.push({ id: p.id, title: p.title, handle: p.handle || null, imageUrl: p.featuredMedia?.preview?.image?.url || null });
    }
  }
  if (!found.length) return { status: "not_buyer" };
  return { status: "eligible", products: found.slice(0, MAX_POST_PRODUCTS) };
}

// ── Customer-facing reward wording ──────────────────────────────

export type WallRewardFields = {
  rewardType: string;
  discountCodeAmount?: number | null;
  discountCodeType?: string | null;
  discountCodeExpiryDays?: number | null;
  storeCreditAmount?: number | null;
  storeCreditExpiryDays?: number | null;
};

/** Short badge text: "25% off your next order", "$15 store credit", "Get featured on the wall" */
export function wallRewardOffer(c: WallRewardFields, currency = "USD"): string {
  if (c.rewardType === "DISCOUNT_CODE") {
    const amt = Number(c.discountCodeAmount || 0);
    const v = c.discountCodeType === "FIXED_AMOUNT" ? `${money(amt, currency)} off` : `${amt}% off`;
    return `${v} your next order`;
  }
  if (c.rewardType === "STORE_CREDIT") return `${money(Number(c.storeCreditAmount || 0), currency)} store credit`;
  return "Get featured on the wall";
}

/** Whether approved posts earn something beyond being featured. */
export function hasReward(c: { rewardType: string }) {
  return c.rewardType === "DISCOUNT_CODE" || c.rewardType === "STORE_CREDIT";
}
