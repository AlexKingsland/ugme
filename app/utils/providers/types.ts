/**
 * Subscription provider adapter interface.
 *
 * Every subscription app UGME integrates with (Recharge, Shopify-native
 * selling plans, later Loop / Bold / Appstle / Seal …) implements this one
 * interface. Call sites ask the adapter — never `if (provider === "RECHARGE")`.
 *
 * `capabilities` is the single source of truth for what a provider can do.
 * The campaign reward UI, campaign validation, approval and reward gating
 * should all read from it.
 */
import type { SubscriptionProvider } from "@prisma/client";

export type ProviderId = SubscriptionProvider;
export type BillingFrequency = "DAY" | "WEEK" | "MONTH";
export type SubscriptionDiscountType = "FREE" | "PERCENTAGE" | "FIXED_AMOUNT";

export interface ProviderCapabilities {
  subscriptionDiscount: {
    /** UGME can apply subscription-discount rewards through this provider today. */
    supported: boolean;
    /** Why not, when unsupported — shown to merchants as-is. */
    unsupportedReason?: string;
    discountTypes: SubscriptionDiscountType[];
    /** Billing intervals the provider can discount. */
    frequencies: BillingFrequency[];
    /** Max number of billing cycles a single reward can cover (null = no cap). */
    maxCycles: number | null;
    /** Discount can target one product inside a bundled charge. */
    productScoped: boolean;
    /** false → only one discount can be active per customer at a time (Recharge: per address). */
    stacksWithExisting: boolean;
  };
  /** Provider can tell us whether a customer actively subscribes to a product. */
  verifiesSubscribers: boolean;
}

/** Minimal shape of the Shopify Admin GraphQL client from `authenticate.admin`. */
export interface AdminGraphqlClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface ProviderContext {
  /** Merchant's provider API key/token (Recharge), if any. */
  apiKey?: string | null;
  /** Shopify Admin API client, when called from an authenticated admin request. */
  admin?: AdminGraphqlClient;
}

export type SubscriberCheck =
  | { status: "eligible"; subscriptionIds: string[] }
  | { status: "no_customer" }
  | { status: "no_matching_subscription" };

export interface ApplySubscriptionRewardArgs {
  shopifyCustomerId: string;
  shopifyProductId: string;
  subscriptionId: string;
  campaignTitle: string;
  submissionId: string;
  discountType: SubscriptionDiscountType;
  discountValue: number;
  rewardCycles: number;
}

export interface AppliedSubscriptionReward {
  /** Provider's discount ID (stored in Reward.externalDiscountId). */
  externalDiscountId: string;
  /** What the discount is attached to — Recharge address ID (stored in Reward.rechargeChargeId). */
  externalTargetId: string | null;
  discountCode: string | null;
}

export interface ExistingSubscriptionReward {
  externalDiscountId: string | null;
  externalTargetId: string | null;
}

export interface ConnectionTestCheck {
  name: string;
  endpoint: string;
  passed: boolean;
  detail?: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message?: string;
  error?: string;
  results?: ConnectionTestCheck[];
}

export interface SubscriptionProviderAdapter {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;

  /** Settings → "Test connection". `apiKey` is the value typed in the form. */
  testConnection(ctx: ProviderContext): Promise<ConnectionTestResult>;

  /** Campaign creation: does this product have subscriptions/selling plans? Throws on API errors. */
  productHasSubscriptions(ctx: ProviderContext, shopifyProductId: string): Promise<boolean>;

  /** Storefront: does this customer actively subscribe to the product? Throws on API errors (callers fail open). */
  checkSubscriber(ctx: ProviderContext, shopifyCustomerId: string, shopifyProductId: string): Promise<SubscriberCheck>;

  /** Approval: attach the reward to the customer's subscription. Throws on failure. */
  applySubscriptionReward(ctx: ProviderContext, args: ApplySubscriptionRewardArgs): Promise<AppliedSubscriptionReward>;

  /** Approval (single-discount providers): remove a previously applied reward. Best-effort, never throws. */
  removeSubscriptionReward(ctx: ProviderContext, existing: ExistingSubscriptionReward): Promise<void>;
}
