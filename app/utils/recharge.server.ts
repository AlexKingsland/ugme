/**
 * Recharge API client for UGME
 *
 * Handles:
 * - Customer lookup by Shopify customer ID
 * - Active subscription verification
 * - Discount creation and application to subscription addresses
 *
 * Discount strategy: product-scoped discounts applied at the address level.
 * Recharge natively handles multi-cycle persistence via max_subsequent_redemptions,
 * so we apply once and Recharge auto-applies to future charges — no recurring job.
 */

const RECHARGE_BASE = "https://api.rechargeapps.com";
const RECHARGE_VERSION = "2021-11";

// ── Types ──────────────────────────────────────────────────────────

export interface RechargeCustomer {
  id: number;
  email: string;
  external_customer_id: { ecommerce: string };
  subscriptions_active_count: number;
}

export interface RechargeSubscription {
  id: number;
  customer_id: number;
  address_id: number;
  status: string;
  product_title: string;
  price: string;
  order_interval_unit: string;
  order_interval_frequency: number;
  next_charge_scheduled_at: string | null;
  cancelled_at: string | null;
  external_product_id: { ecommerce: string };
}

export interface RechargeCharge {
  id: number;
  customer_id: number;
  status: string;
  scheduled_at: string;
  total_price: string;
  line_items: Array<{
    purchase_item_id: number;
    external_product_id: { ecommerce: string };
    title: string;
    total_price: string;
  }>;
  discounts: Array<{
    id: number;
    code: string;
    value: number;
    value_type: string;
  }>;
}

export interface RechargeDiscount {
  id: number;
  code: string;
  value: string;
  value_type: string;
  status: string;
}

export interface RechargeAddress {
  id: number;
  customer_id: number;
  discounts: Array<{ id: number }>;
}

// ── API helpers ────────────────────────────────────────────────────

function getToken(): string {
  const token = process.env.RECHARGE_API_TOKEN;
  if (!token) throw new Error("RECHARGE_API_TOKEN not set");
  return token;
}

async function rechargeGet<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${RECHARGE_BASE}${path}`, {
    headers: {
      "X-Recharge-Access-Token": token || getToken(),
      "X-Recharge-Version": RECHARGE_VERSION,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Recharge GET ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

async function rechargePost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${RECHARGE_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Recharge-Access-Token": token || getToken(),
      "X-Recharge-Version": RECHARGE_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new Error(`Recharge POST ${path} failed: ${res.status} ${respBody}`);
  }
  return res.json() as Promise<T>;
}

async function rechargePut<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${RECHARGE_BASE}${path}`, {
    method: "PUT",
    headers: {
      "X-Recharge-Access-Token": token || getToken(),
      "X-Recharge-Version": RECHARGE_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new Error(`Recharge PUT ${path} failed: ${res.status} ${respBody}`);
  }
  return res.json() as Promise<T>;
}

async function rechargeDelete(path: string, token?: string): Promise<void> {
  const res = await fetch(`${RECHARGE_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "X-Recharge-Access-Token": token || getToken(),
      "X-Recharge-Version": RECHARGE_VERSION,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Recharge DELETE ${path} failed: ${res.status} ${body}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Look up a Recharge customer by their Shopify customer ID.
 * Returns null if the customer doesn't exist in Recharge.
 */
export async function getRechargeCustomer(
  shopifyCustomerId: string,
  token?: string
): Promise<RechargeCustomer | null> {
  const data = await rechargeGet<{ customers: RechargeCustomer[] }>(
    `/customers?external_customer_id=${shopifyCustomerId}`,
    token
  );
  return data.customers[0] || null;
}

/**
 * Check if a Recharge customer has at least one active subscription.
 * Returns the first active subscription, or null.
 */
export async function getActiveSubscription(
  rechargeCustomerId: number,
  token?: string
): Promise<RechargeSubscription | null> {
  const data = await rechargeGet<{ subscriptions: RechargeSubscription[] }>(
    `/subscriptions?customer_id=${rechargeCustomerId}&status=active`,
    token
  );
  return data.subscriptions[0] || null;
}

/**
 * Get active subscriptions for a specific Shopify product.
 * Used to verify the customer subscribes to the campaign's product
 * and to let them pick which subscription to tie to their submission.
 */
export async function getActiveSubscriptionsForProduct(
  rechargeCustomerId: number,
  shopifyProductId: string,
  token?: string
): Promise<RechargeSubscription[]> {
  const data = await rechargeGet<{ subscriptions: RechargeSubscription[] }>(
    `/subscriptions?customer_id=${rechargeCustomerId}&status=active`,
    token
  );

  // Strip GID prefix: "gid://shopify/Product/123" → "123"
  const numericId = shopifyProductId.replace(/^gid:\/\/shopify\/Product\//, "");

  return data.subscriptions.filter(
    (s) => s.external_product_id?.ecommerce === numericId
  );
}

/**
 * Verify that a Shopify customer is an active Recharge subscriber.
 * Combines customer lookup + subscription check in one call.
 */
export async function verifyActiveSubscriber(
  shopifyCustomerId: string,
  token?: string
): Promise<{
  isActive: boolean;
  rechargeCustomerId?: number;
  subscription?: RechargeSubscription;
}> {
  const customer = await getRechargeCustomer(shopifyCustomerId, token);
  if (!customer) return { isActive: false };

  const subscription = await getActiveSubscription(customer.id, token);
  if (!subscription) return { isActive: false };

  return {
    isActive: true,
    rechargeCustomerId: customer.id,
    subscription,
  };
}

/**
 * Get a subscription by its Recharge subscription ID.
 * Needed to find the address_id for discount application.
 */
export async function getSubscription(
  subscriptionId: number,
  token?: string
): Promise<RechargeSubscription> {
  const data = await rechargeGet<{ subscription: RechargeSubscription }>(
    `/subscriptions/${subscriptionId}`,
    token
  );
  return data.subscription;
}

/**
 * Create a product-scoped discount in Recharge.
 *
 * - Scoped to a specific Shopify product via applies_to.resource + ids
 * - Multi-cycle support via max_subsequent_redemptions
 * - Applied at the address level, so Recharge auto-applies to future charges
 */
export async function createProductDiscount(
  code: string,
  valueType: "fixed_amount" | "percentage",
  value: string,
  shopifyProductId: string,
  rewardCycles: number,
  token?: string
): Promise<RechargeDiscount> {
  // Strip GID prefix if present
  const numericId = shopifyProductId.replace(/^gid:\/\/shopify\/Product\//, "");

  const data = await rechargePost<{ discount: RechargeDiscount }>(
    "/discounts",
    {
      code,
      discount_type: valueType,
      value,
      value_type: valueType,
      applies_to: {
        purchase_item_type: "SUBSCRIPTION",
        resource: "shopify_product",
        ids: [parseInt(numericId, 10)],
      },
      usage_limits: {
        max_subsequent_redemptions: Math.max(0, rewardCycles - 1),
      },
      channel_settings: {
        api: { can_apply: true },
        checkout_page: { can_apply: false },
        customer_portal: { can_apply: false },
        merchant_portal: { can_apply: true },
      },
      status: "enabled",
    },
    token
  );
  return data.discount;
}

/**
 * Apply a discount to an address by updating its discounts array.
 * Recharge addresses support only ONE discount at a time.
 *
 * Note: if the address already has a UGME discount for a different product,
 * this will replace it. Multi-product discounts on the same address require
 * combining into a single fixed_amount discount (future enhancement).
 */
export async function applyDiscountToAddress(
  addressId: number,
  discountCode: string,
  token?: string
): Promise<RechargeAddress> {
  const data = await rechargePut<{ address: RechargeAddress }>(
    `/addresses/${addressId}`,
    { discounts: [{ code: discountCode }] },
    token
  );
  return data.address;
}

/**
 * Remove all discounts from an address.
 */
export async function clearAddressDiscounts(
  addressId: number,
  token?: string
): Promise<void> {
  await rechargePut<{ address: RechargeAddress }>(
    `/addresses/${addressId}`,
    { discounts: [] },
    token
  );
}

/**
 * Delete a discount.
 */
export async function deleteDiscount(
  discountId: number,
  token?: string
): Promise<void> {
  await rechargeDelete(`/discounts/${discountId}`, token);
}

/**
 * Full reward flow: create a product-scoped discount and apply it to
 * the subscription's address so Recharge handles it natively.
 *
 * Flow:
 * 1. Look up customer in Recharge
 * 2. Get the subscription to find its address_id
 * 3. Create a product-scoped discount with multi-cycle support
 * 4. Apply discount to the address
 *
 * Recharge auto-applies the discount to all future charges on that address
 * that contain the target product, for the specified number of cycles.
 * No recurring job needed.
 */
export async function applyRewardToNextCharge(params: {
  shopifyCustomerId: string;
  shopifyProductId: string;
  rechargeSubscriptionId: number;
  campaignTitle: string;
  submissionId: string;
  discountType: "FREE" | "FIXED_AMOUNT" | "PERCENTAGE";
  discountValue: number;
  rewardCycles: number;
  token?: string;
}): Promise<{
  discountId: number;
  discountCode: string;
  addressId: number;
}> {
  const {
    shopifyCustomerId,
    shopifyProductId,
    rechargeSubscriptionId,
    campaignTitle,
    submissionId,
    discountType,
    discountValue,
    rewardCycles,
    token,
  } = params;

  // 1. Verify customer exists in Recharge
  const customer = await getRechargeCustomer(shopifyCustomerId, token);
  if (!customer) throw new Error("Customer not found in Recharge");

  // 2. Get the subscription to find its address
  const subscription = await getSubscription(rechargeSubscriptionId, token);
  if (!subscription.address_id) {
    throw new Error("Subscription has no address");
  }

  // 3. Determine discount parameters
  let valueType: "fixed_amount" | "percentage";
  let value: string;

  if (discountType === "FREE") {
    valueType = "percentage";
    value = "100";
  } else if (discountType === "PERCENTAGE") {
    valueType = "percentage";
    value = String(discountValue);
  } else {
    valueType = "fixed_amount";
    value = String(discountValue);
  }

  // 4. Generate a unique discount code
  const shortId = submissionId.slice(-6).toUpperCase();
  const slug = campaignTitle
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 10)
    .toUpperCase();
  const code = `UGME-${slug}-${shortId}`;

  // 5. Create product-scoped discount with multi-cycle support
  const discount = await createProductDiscount(
    code,
    valueType,
    value,
    shopifyProductId,
    rewardCycles,
    token
  );

  // 6. Apply to the subscription's address
  try {
    await applyDiscountToAddress(subscription.address_id, code, token);
    return {
      discountId: discount.id,
      discountCode: code,
      addressId: subscription.address_id,
    };
  } catch (err) {
    // Cleanup: delete the discount if we couldn't apply it
    try {
      await deleteDiscount(discount.id, token);
    } catch {}
    throw err;
  }
}
