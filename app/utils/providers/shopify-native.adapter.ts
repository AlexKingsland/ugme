/**
 * Shopify-native selling plans (Loop, Bold, Appstle, Seal … via Shopify's
 * subscription APIs).
 *
 * Today UGME only uses Shopify here to (a) test discount API access and
 * (b) check whether a product has selling plans. Applying subscription
 * discounts (discountCodeBasicCreate + recurringCycleLimit) is NOT built yet,
 * so `subscriptionDiscount.supported` is false — approval records the reward
 * as CREATED without touching the subscription, exactly as before.
 */
import type { SubscriptionProviderAdapter } from "./types";

export const shopifyNativeAdapter: SubscriptionProviderAdapter = {
  id: "SHOPIFY_NATIVE",
  displayName: "Shopify subscriptions",

  capabilities: {
    subscriptionDiscount: {
      supported: false,
      unsupportedReason: "Subscription discounts through Shopify selling plans aren't supported yet.",
      discountTypes: [],
      frequencies: [],
      maxCycles: null,
      productScoped: false,
      stacksWithExisting: true,
    },
    verifiesSubscribers: false,
  },

  async testConnection(ctx) {
    if (!ctx.admin) throw new Error("Shopify admin client required");
    const response = await ctx.admin.graphql(
      `#graphql
        query {
          codeDiscountNodes(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }`,
    );
    const data: any = await response.json();

    if (data.errors && data.errors.length > 0) {
      return {
        success: false,
        error: "Cannot access Shopify Discounts API. Make sure the app has the 'write_discounts' scope.",
      };
    }

    return {
      success: true,
      message: "Connected to Shopify Native Discounts. You're all set to create discount codes for approved submissions.",
    };
  },

  async productHasSubscriptions(ctx, shopifyProductId) {
    if (!ctx.admin) throw new Error("Shopify admin client required");
    const response = await ctx.admin.graphql(
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
      { variables: { productId: shopifyProductId } },
    );
    const data: any = await response.json();
    const edges = data?.data?.product?.sellingPlanGroups?.edges ?? [];
    console.log("[UGME] Shopify selling plans for", shopifyProductId, "— found:", edges.length);
    return edges.length > 0;
  },

  async checkSubscriber() {
    // verifiesSubscribers: false — callers don't gate on this provider.
    throw new Error("Shopify-native subscriber verification is not implemented");
  },

  async applySubscriptionReward() {
    throw new Error("Shopify-native subscription discounts are not implemented");
  },

  async removeSubscriptionReward() {
    // Nothing is ever applied, so nothing to remove.
  },
};
