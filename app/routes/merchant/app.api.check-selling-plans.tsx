import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

/**
 * API route to check whether a product has subscription support.
 * Checks the merchant's actual connected subscription provider:
 * - Recharge: queries Recharge API for the product
 * - Shopify Native: queries Shopify's sellingPlanGroups GraphQL API
 *
 * GET /app/api/check-selling-plans?productId=gid://shopify/Product/123
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ hasSellingPlans: false });
  }

  // Look up the shop's subscription provider config
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: {
      subscriptionProvider: true,
      providerConnected: true,
      providerApiKey: true,
    },
  });

  if (!shop?.providerConnected) {
    return json({ hasSellingPlans: false });
  }

  try {
    // ── Recharge provider ──────────────────────────────────────
    if (shop.subscriptionProvider === "RECHARGE" && shop.providerApiKey) {
      // Extract numeric Shopify product ID from GID
      const numericId = productId.replace(/^gid:\/\/shopify\/Product\//, "");

      // Query subscriptions endpoint (tokens typically have this scope)
      // to check if any active subscription exists for this product
      const rechargeRes = await fetch(
        `https://api.rechargeapps.com/subscriptions?external_product_id=${numericId}&status=active&limit=1`,
        {
          headers: {
            "X-Recharge-Access-Token": shop.providerApiKey,
            "X-Recharge-Version": "2021-11",
          },
        },
      );

      if (!rechargeRes.ok) {
        console.error("[UGME] Recharge subscriptions API error:", rechargeRes.status, await rechargeRes.text());
        return json({ hasSellingPlans: false });
      }

      const rechargeData: any = await rechargeRes.json();
      const subscriptions = rechargeData?.subscriptions ?? [];
      console.log("[UGME] Recharge subscription check for product", numericId, "— found:", subscriptions.length, "subscriptions");
      return json({ hasSellingPlans: subscriptions.length > 0 });
    }

    // ── Shopify Native provider ────────────────────────────────
    const response = await admin.graphql(
      `#graphql
      query checkSellingPlans($productId: ID!) {
        product(id: $productId) {
          sellingPlanGroups(first: 1) {
            edges {
              node { id name }
            }
          }
        }
      }`,
      { variables: { productId } },
    );

    const data: any = await response.json();
    const edges = data?.data?.product?.sellingPlanGroups?.edges ?? [];
    console.log("[UGME] Shopify selling plans for", productId, "— found:", edges.length);
    return json({ hasSellingPlans: edges.length > 0 });
  } catch (error) {
    console.error("[UGME] check-selling-plans error:", error);
    return json({ hasSellingPlans: false });
  }
};
