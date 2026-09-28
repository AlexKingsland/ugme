/**
 * Reward gating utilities for UGME
 *
 * Checks whether a customer has an existing active reward from a provider
 * that only supports one discount at a time (e.g. Recharge — one discount
 * per address). Returns a warning with details so the customer can make an
 * informed choice; does NOT hard-block submission.
 *
 * At approval time, the existing discount is replaced automatically.
 */

import prisma from "../db.server";
import type { SubscriptionProvider } from "@prisma/client";

// ── Providers with single-discount limitation ──────────────────────
// Add providers here as we discover per-address (or per-subscription)
// discount limits. Each entry means: "only one UGME reward can be active
// at a time for a customer on this provider."

export const SINGLE_DISCOUNT_PROVIDERS: ReadonlySet<SubscriptionProvider> =
  new Set<SubscriptionProvider>(["RECHARGE"]);

export function isSingleDiscountProvider(
  provider: SubscriptionProvider
): boolean {
  return SINGLE_DISCOUNT_PROVIDERS.has(provider);
}

// ── Gating result ──────────────────────────────────────────────────

export interface GatingWarning {
  /** true when the customer has an active reward that will be replaced */
  hasActiveReward: boolean;
  /** Human-readable warning shown to the customer */
  message?: string;
  /** Title of the campaign the existing reward belongs to */
  existingCampaignTitle?: string;
  /** Estimated expiry date of the active reward */
  estimatedExpiry?: string; // ISO string for serialisation across loader boundary
}

/**
 * Check if a customer has an active UGME reward on a single-discount
 * provider. Returns a warning (not a block) so the customer can decide
 * whether to submit knowing their current reward will be replaced on
 * approval.
 *
 * Only checks for providers in SINGLE_DISCOUNT_PROVIDERS. Other
 * providers return { hasActiveReward: false } immediately.
 */
export async function checkRewardGating(params: {
  customerId: string;
  shopId: string;
  subscriptionProvider: SubscriptionProvider;
}): Promise<GatingWarning> {
  const { customerId, shopId, subscriptionProvider } = params;

  if (!isSingleDiscountProvider(subscriptionProvider)) {
    return { hasActiveReward: false };
  }

  // Find APPLIED rewards for this customer via this provider
  const activeRewards = await prisma.reward.findMany({
    where: {
      customerId,
      discountProvider: subscriptionProvider,
      status: "APPLIED",
    },
    include: {
      submission: {
        include: {
          campaign: {
            select: {
              title: true,
              rewardCycles: true,
              rewardFrequency: true,
              shopId: true,
            },
          },
        },
      },
    },
    orderBy: { appliedAt: "desc" },
  });

  for (const reward of activeRewards) {
    const campaign = reward.submission.campaign;

    // Only consider rewards from the same shop
    if (campaign.shopId !== shopId) continue;

    if (!reward.appliedAt) continue;

    const appliedAt = new Date(reward.appliedAt);
    let daysPerCycle: number;

    switch (campaign.rewardFrequency) {
      case "DAY":
        daysPerCycle = 1;
        break;
      case "WEEK":
        daysPerCycle = 7;
        break;
      case "MONTH":
      default:
        daysPerCycle = 30;
        break;
    }

    const totalDays = reward.cycles * daysPerCycle;
    const estimatedExpiry = new Date(
      appliedAt.getTime() + totalDays * 24 * 60 * 60 * 1000
    );

    // 3-day buffer for billing timing
    const expiryWithBuffer = new Date(
      estimatedExpiry.getTime() + 3 * 24 * 60 * 60 * 1000
    );

    if (expiryWithBuffer > new Date()) {
      const expiryStr = estimatedExpiry.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });

      return {
        hasActiveReward: true,
        message:
          `You currently have an active reward from the "${campaign.title}" campaign ` +
          `(running until approximately ${expiryStr}). ` +
          `Your subscription provider only allows one discount at a time — ` +
          `if you're approved for this campaign, your current reward will be replaced with the new one.`,
        existingCampaignTitle: campaign.title,
        estimatedExpiry: estimatedExpiry.toISOString(),
      };
    }
  }

  return { hasActiveReward: false };
}

/**
 * Find the active reward record for a customer on a single-discount
 * provider, so approval can replace it.
 *
 * Returns the Reward row (with its Recharge address & discount IDs)
 * or null if no active reward exists.
 */
export async function findActiveRewardToReplace(params: {
  customerId: string;
  shopId: string;
  subscriptionProvider: SubscriptionProvider;
}): Promise<{
  rewardId: string;
  externalDiscountId: string | null;
  rechargeChargeId: string | null; // actually addressId
  discountCode: string | null;
} | null> {
  const { customerId, shopId, subscriptionProvider } = params;

  if (!isSingleDiscountProvider(subscriptionProvider)) {
    return null;
  }

  const reward = await prisma.reward.findFirst({
    where: {
      customerId,
      discountProvider: subscriptionProvider,
      status: "APPLIED",
      submission: {
        campaign: { shopId },
      },
    },
    select: {
      id: true,
      externalDiscountId: true,
      rechargeChargeId: true,
      discountCode: true,
    },
    orderBy: { appliedAt: "desc" },
  });

  if (!reward) return null;
  return {
    rewardId: reward.id,
    externalDiscountId: reward.externalDiscountId,
    rechargeChargeId: reward.rechargeChargeId,
    discountCode: reward.discountCode,
  };
}
