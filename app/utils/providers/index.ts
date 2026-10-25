/**
 * Provider registry. Everything provider-specific goes through here:
 *
 *   const provider = getProviderAdapter(shop.subscriptionProvider);
 *   if (provider.capabilities.verifiesSubscribers) { … }
 *
 * Adding a provider = add a SubscriptionProvider enum value, write an
 * adapter implementing SubscriptionProviderAdapter, register it below.
 */
import type { SubscriptionProvider } from "@prisma/client";
import { rechargeAdapter } from "./recharge.adapter";
import { shopifyNativeAdapter } from "./shopify-native.adapter";
import type { SubscriptionProviderAdapter } from "./types";

export * from "./types";

const ADAPTERS: Record<SubscriptionProvider, SubscriptionProviderAdapter> = {
  RECHARGE: rechargeAdapter,
  SHOPIFY_NATIVE: shopifyNativeAdapter,
};

export function getProviderAdapter(id: SubscriptionProvider | string): SubscriptionProviderAdapter {
  const adapter = ADAPTERS[id as SubscriptionProvider];
  if (!adapter) throw new Error(`Unknown subscription provider: ${id}`);
  return adapter;
}

export function listProviderAdapters(): SubscriptionProviderAdapter[] {
  return Object.values(ADAPTERS);
}
