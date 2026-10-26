/**
 * Server half of wall campaigns: the verified-buyer check against Shopify.
 * Pure helpers (shared with the admin UI) live in ./wall-campaigns.ts.
 */
import type { AdminGraphqlClient } from "./providers";
import { matchPurchasedProducts, type BuyerCheck, type OrderNode, type ProductScope, type WallProduct } from "./wall-campaigns";

export * from "./wall-campaigns";

const BUYER_ORDERS_QUERY = `#graphql
  query WallBuyerOrders($q: String!) {
    orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes {
        cancelledAt
        lineItems(first: 50) {
          nodes { product { id title handle featuredMedia { preview { image { url } } } } }
        }
      }
    }
  }`;

/**
 * Has this customer bought one of the wall's products? Uses the Admin API
 * (`read_orders` — Shopify returns the last 60 days of orders unless the app
 * has `read_all_orders`). Never throws: problems come back as status "error".
 */
export async function verifyBuyer(
  admin: AdminGraphqlClient,
  shopifyCustomerId: string,
  scope: ProductScope,
  wallProducts: WallProduct[],
): Promise<BuyerCheck> {
  const numericId = shopifyCustomerId.replace(/^gid:\/\/shopify\/Customer\//, "");
  if (!/^\d+$/.test(numericId)) return { status: "error", reason: "invalid customer id" };
  if (scope === "SPECIFIC" && !wallProducts.length) return { status: "error", reason: "wall campaign has no products" };
  try {
    const res = await admin.graphql(BUYER_ORDERS_QUERY, { variables: { q: `customer_id:${numericId}` } });
    const body: any = await res.json().catch(() => ({}));
    if (body?.errors?.length) {
      const msg = body.errors.map((e: any) => e.message).join("; ");
      console.error("[wall] buyer check failed:", msg);
      return { status: "error", reason: msg };
    }
    const orders: OrderNode[] = body?.data?.orders?.nodes ?? [];
    return matchPurchasedProducts(orders, scope, wallProducts);
  } catch (err) {
    console.error("[wall] buyer check failed:", err);
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

