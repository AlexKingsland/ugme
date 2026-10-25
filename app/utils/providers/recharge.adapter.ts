/**
 * Recharge adapter — wraps the existing Recharge client (../recharge.server)
 * so behaviour is identical; it only moves *where* the provider decisions live.
 */
import {
  applyRewardToNextCharge,
  clearAddressDiscounts,
  deleteDiscount,
  getActiveSubscriptionsForProduct,
  getRechargeCustomer,
} from "../recharge.server";
import { shopifyNativeAdapter } from "./shopify-native.adapter";
import type { ConnectionTestCheck, SubscriptionProviderAdapter } from "./types";

const RECHARGE_BASE = "https://api.rechargeapps.com";
const RECHARGE_VERSION = "2021-11";

export const rechargeAdapter: SubscriptionProviderAdapter = {
  id: "RECHARGE",
  displayName: "Recharge",

  capabilities: {
    subscriptionDiscount: {
      supported: true,
      discountTypes: ["FREE", "PERCENTAGE", "FIXED_AMOUNT"],
      // Discounts apply per charge, whatever the order interval.
      frequencies: ["DAY", "WEEK", "MONTH"],
      maxCycles: null,
      // applies_to: shopify_product — targets one product in a bundled charge.
      productScoped: true,
      // Recharge allows only one discount per address at a time.
      stacksWithExisting: false,
    },
    verifiesSubscribers: true,
  },

  /**
   * Validates every endpoint UGME needs:
   *   GET /discounts, GET /customers, GET /subscriptions, GET /addresses/:id,
   *   POST /discounts (test discount) and DELETE /discounts/:id (clean-up).
   */
  async testConnection(ctx) {
    const apiKey = ctx.apiKey;
    if (!apiKey || apiKey.trim() === "") {
      return { success: false, error: "Please enter your ReCharge API token." };
    }

    const token = apiKey.trim();
    const headers = {
      "X-Recharge-Access-Token": token,
      "X-Recharge-Version": RECHARGE_VERSION,
      "Content-Type": "application/json",
    };

    const results: ConnectionTestCheck[] = [];

    // 1. Test authentication + read discounts
    try {
      const res = await fetch(`${RECHARGE_BASE}/discounts?limit=1`, { headers });
      if (res.status === 401 || res.status === 403) {
        return { success: false, error: "Invalid ReCharge API token. Please check your token and try again." };
      }
      results.push({
        name: "Read discounts",
        endpoint: "GET /discounts",
        passed: res.ok,
        detail: res.ok ? undefined : `Status ${res.status}`,
      });
    } catch (err) {
      return {
        success: false,
        error: `Could not reach ReCharge API: ${err instanceof Error ? err.message : "Unknown error"}`,
      };
    }

    // 2. Test read customers
    try {
      const res = await fetch(`${RECHARGE_BASE}/customers?limit=1`, { headers });
      results.push({
        name: "Read customers",
        endpoint: "GET /customers",
        passed: res.ok,
        detail: res.ok ? undefined : `Status ${res.status}`,
      });
    } catch (err) {
      results.push({
        name: "Read customers",
        endpoint: "GET /customers",
        passed: false,
        detail: err instanceof Error ? err.message : "Network error",
      });
    }

    // 3. Test read subscriptions (also grab address_id for test 4)
    let testAddressId: number | null = null;
    try {
      const res = await fetch(`${RECHARGE_BASE}/subscriptions?limit=1`, { headers });
      if (res.ok) {
        const subData: any = await res.json();
        const sub = subData.subscriptions?.[0];
        testAddressId = sub?.address_id ?? null;
      }
      results.push({
        name: "Read subscriptions",
        endpoint: "GET /subscriptions",
        passed: res.ok,
        detail: res.ok ? undefined : `Status ${res.status}`,
      });
    } catch (err) {
      results.push({
        name: "Read subscriptions",
        endpoint: "GET /subscriptions",
        passed: false,
        detail: err instanceof Error ? err.message : "Network error",
      });
    }

    // 4. Test read addresses (needed for applying/clearing discounts)
    try {
      if (testAddressId) {
        const res = await fetch(`${RECHARGE_BASE}/addresses/${testAddressId}`, { headers });
        results.push({
          name: "Read address",
          endpoint: "GET /addresses/:id",
          passed: res.ok,
          detail: res.ok ? undefined : `Status ${res.status}`,
        });
      } else {
        // No subscriptions exist yet — skip with a note
        results.push({
          name: "Read address",
          endpoint: "GET /addresses/:id",
          passed: true,
          detail: "Skipped (no subscriptions yet) — will work once customers subscribe",
        });
      }
    } catch (err) {
      results.push({
        name: "Read address",
        endpoint: "GET /addresses/:id",
        passed: false,
        detail: err instanceof Error ? err.message : "Network error",
      });
    }

    // 5. Test write: create a test discount, then immediately delete it
    let testDiscountId: number | null = null;
    try {
      const testCode = `UGME_CONNECTION_TEST_${Date.now()}`;
      const createRes = await fetch(`${RECHARGE_BASE}/discounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          channel: "checkout_page",
          code: testCode,
          discount_type: "percentage",
          value_type: "percentage",
          value: "0.01",
          status: "disabled",
        }),
      });

      if (createRes.ok) {
        const createData: any = await createRes.json();
        testDiscountId = createData.discount?.id;
        results.push({ name: "Create discount", endpoint: "POST /discounts", passed: true });
      } else {
        const errBody = await createRes.text();
        results.push({
          name: "Create discount",
          endpoint: "POST /discounts",
          passed: false,
          detail: `Status ${createRes.status}: ${errBody.slice(0, 200)}`,
        });
      }
    } catch (err) {
      results.push({
        name: "Create discount",
        endpoint: "POST /discounts",
        passed: false,
        detail: err instanceof Error ? err.message : "Network error",
      });
    }

    // 6. Clean up: delete the test discount
    if (testDiscountId) {
      try {
        const delRes = await fetch(`${RECHARGE_BASE}/discounts/${testDiscountId}`, { method: "DELETE", headers });
        results.push({
          name: "Delete discount",
          endpoint: "DELETE /discounts/:id",
          passed: delRes.ok || delRes.status === 204,
          detail: delRes.ok || delRes.status === 204 ? undefined : `Status ${delRes.status}`,
        });
      } catch (err) {
        results.push({
          name: "Delete discount",
          endpoint: "DELETE /discounts/:id",
          passed: false,
          detail: err instanceof Error ? err.message : "Network error",
        });
      }
    }

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const failedNames = failed.map((f) => `${f.name} (${f.detail || f.endpoint})`).join(", ");
      return {
        success: false,
        error: `Some API checks failed: ${failedNames}. Make sure your token has read & write access to Discounts, Customers, Subscriptions, and Addresses.`,
        results,
      };
    }

    return {
      success: true,
      message: `All ${results.length} API checks passed. UGME can read customers, subscriptions, and addresses, and create and manage discounts.`,
      results,
    };
  },

  async productHasSubscriptions(ctx, shopifyProductId) {
    // Legacy behaviour: a Recharge shop with no saved token falls back to
    // Shopify's own selling-plan check.
    if (!ctx.apiKey) return shopifyNativeAdapter.productHasSubscriptions(ctx, shopifyProductId);

    const numericId = shopifyProductId.replace(/^gid:\/\/shopify\/Product\//, "");
    // Query subscriptions endpoint (tokens typically have this scope)
    // to check if any active subscription exists for this product
    const rechargeRes = await fetch(
      `${RECHARGE_BASE}/subscriptions?external_product_id=${numericId}&status=active&limit=1`,
      {
        headers: {
          "X-Recharge-Access-Token": ctx.apiKey,
          "X-Recharge-Version": RECHARGE_VERSION,
        },
      },
    );

    if (!rechargeRes.ok) {
      console.error("[UGME] Recharge subscriptions API error:", rechargeRes.status, await rechargeRes.text());
      return false;
    }

    const rechargeData: any = await rechargeRes.json();
    const subscriptions = rechargeData?.subscriptions ?? [];
    console.log("[UGME] Recharge subscription check for product", numericId, "— found:", subscriptions.length, "subscriptions");
    return subscriptions.length > 0;
  },

  async checkSubscriber(ctx, shopifyCustomerId, shopifyProductId) {
    const token = ctx.apiKey || undefined;
    const rechargeCustomer = await getRechargeCustomer(shopifyCustomerId, token);
    if (!rechargeCustomer) return { status: "no_customer" };
    const subs = await getActiveSubscriptionsForProduct(rechargeCustomer.id, shopifyProductId, token);
    if (subs.length === 0) return { status: "no_matching_subscription" };
    return { status: "eligible", subscriptionIds: subs.map((s) => String(s.id)) };
  },

  async applySubscriptionReward(ctx, args) {
    const result = await applyRewardToNextCharge({
      shopifyCustomerId: args.shopifyCustomerId,
      shopifyProductId: args.shopifyProductId,
      rechargeSubscriptionId: parseInt(args.subscriptionId, 10),
      campaignTitle: args.campaignTitle,
      submissionId: args.submissionId,
      discountType: args.discountType,
      discountValue: args.discountValue,
      rewardCycles: args.rewardCycles,
      token: ctx.apiKey || undefined,
    });
    return {
      externalDiscountId: String(result.discountId),
      externalTargetId: String(result.addressId),
      discountCode: result.discountCode,
    };
  },

  async removeSubscriptionReward(ctx, existing) {
    const token = ctx.apiKey || undefined;
    // Clear discount from address first
    if (existing.externalTargetId) {
      try {
        await clearAddressDiscounts(parseInt(existing.externalTargetId, 10), token);
      } catch (err) {
        console.warn("[UGME] Could not clear address discounts (may already be expired):", err);
      }
    }
    // Delete the old discount from Recharge
    if (existing.externalDiscountId) {
      try {
        await deleteDiscount(parseInt(existing.externalDiscountId, 10), token);
      } catch (err) {
        console.warn("[UGME] Could not delete old discount (may already be gone):", err);
      }
    }
  },
};
