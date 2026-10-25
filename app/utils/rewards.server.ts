/**
 * Reward fulfilment — the one place that turns an approved submission into a
 * delivered reward. Used by approval (merchant admin) and by the internal
 * retry script (scripts/retry-rewards.ts). Safe to call repeatedly:
 * an APPLIED reward is never re-applied.
 *
 *   DISCOUNT_CODE         → single-use Shopify discount code for the customer
 *   SUBSCRIPTION_DISCOUNT → discount on the customer's subscription via the
 *                           provider adapter (app/utils/providers)
 *
 * Every attempt records status + failureReason + attemptCount on the Reward
 * row, so stuck rewards can be found and retried by us (not the merchant).
 */
import prisma from "../db.server";
import type { SubscriptionProvider } from "@prisma/client";
import { createCustomerDiscountCode, rewardCodeFor } from "./discount-codes.server";
import { getProviderAdapter, type AdminGraphqlClient } from "./providers";
import { findActiveRewardToReplace, isSingleDiscountProvider } from "./reward-gating.server";
import { sendRewardDeliveredEmail, type NotifyResult } from "./email/notifications.server";

export interface RewardShop {
  id: string;
  subscriptionProvider: SubscriptionProvider;
  providerApiKey: string | null;
  providerConnected: boolean;
}

export interface RewardOutcome {
  status: "APPLIED" | "FAILED";
  /** Internal explanation when FAILED (merchant-visible in admin, never shown to customers). */
  reason?: string;
  replacedRewardId?: string;
  discountCode?: string | null;
  /** The reward was already APPLIED before this call — nothing was done. */
  alreadyApplied?: boolean;
  /** Customer "approved + your reward" email (sent once per submission). */
  email?: NotifyResult;
}

type Fields = {
  externalDiscountId?: string | null;
  rechargeChargeId?: string | null;
  rechargeSubscriptionId?: string | null;
  discountCode?: string | null;
  discountProvider?: string | null;
  expiresAt?: Date | null;
};

class RewardFailure extends Error {}
const fail = (reason: string): never => {
  throw new RewardFailure(reason);
};

export async function fulfillReward(params: {
  submissionId: string;
  shop: RewardShop;
  /** Shopify Admin API client — required for DISCOUNT_CODE rewards. */
  admin?: AdminGraphqlClient;
}): Promise<RewardOutcome> {
  const { submissionId, shop, admin } = params;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      campaign: true,
      customer: { select: { id: true, shopifyCustomerId: true } },
      reward: true,
    },
  });
  if (!submission || submission.campaign.shopId !== shop.id) {
    throw new Error("Submission not found or does not belong to this shop");
  }
  if (submission.status !== "APPROVED") throw new Error("Submission is not approved");

  if (submission.reward?.status === "APPLIED") {
    // Make sure the customer was told (no-op if the email already went out)
    const email = await sendRewardDeliveredEmail(submissionId);
    return { status: "APPLIED", alreadyApplied: true, discountCode: submission.reward.discountCode, email };
  }

  const campaign = submission.campaign;
  let outcome: RewardOutcome;
  let fields: Fields = {};

  try {
    if (campaign.rewardType === "DISCOUNT_CODE") {
      // ── Shopify discount code ───────────────────────────────
      // Configuration problems first (they need a human), then access problems
      const amount = Number(campaign.discountCodeAmount || 0);
      if (!(amount > 0)) fail("Campaign has no discount amount set.");
      if (!submission.customer.shopifyCustomerId) fail("Customer has no Shopify customer ID.");
      if (!admin) fail("Shopify admin access is unavailable for this attempt.");
      const valueType = campaign.discountCodeType === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENTAGE";
      const endsAt = campaign.discountCodeExpiryDays
        ? new Date(Date.now() + campaign.discountCodeExpiryDays * 24 * 60 * 60 * 1000)
        : null;
      const code = submission.reward?.discountCode || rewardCodeFor(campaign.title, submissionId);

      const created = await createCustomerDiscountCode(admin!, {
        code,
        title: `UGME reward — ${campaign.title}`,
        shopifyCustomerId: submission.customer.shopifyCustomerId!,
        valueType,
        amount,
        endsAt,
        minimumSubtotal: campaign.discountCodeMinOrder || null,
      });
      fields = {
        externalDiscountId: created.id,
        discountCode: created.code,
        discountProvider: "SHOPIFY_DISCOUNT_CODE",
        expiresAt: created.reused ? submission.reward?.expiresAt ?? endsAt : endsAt,
      };
      outcome = { status: "APPLIED", discountCode: created.code };
    } else {
      // ── Subscription discount via provider adapter ──────────
      const provider = getProviderAdapter(shop.subscriptionProvider);
      const ctx = { apiKey: shop.providerApiKey, admin };
      if (!shop.providerConnected) fail("Subscription provider isn't connected (Settings → Subscription provider).");
      if (!provider.capabilities.subscriptionDiscount.supported) {
        fail(provider.capabilities.subscriptionDiscount.unsupportedReason || `${provider.displayName} can't apply subscription discounts.`);
      }
      const shopifyCustomerId = submission.customer.shopifyCustomerId || fail("Customer has no Shopify customer ID.");
      const productId = campaign.productId || fail("Campaign has no product.");

      // Re-check the subscription now: days can pass between submitting and
      // approval, and the customer may have cancelled or swapped subscriptions.
      let subscriptionId = submission.subscriptionId;
      if (provider.capabilities.verifiesSubscribers) {
        const check = await provider.checkSubscriber(ctx, shopifyCustomerId, productId);
        if (check.status === "no_customer") fail(`Customer isn't a ${provider.displayName} customer.`);
        if (check.status === "no_matching_subscription") {
          fail(`Customer no longer has an active subscription to ${campaign.productTitle || "the campaign product"}.`);
        }
        if (check.status === "eligible") {
          const resolved =
            subscriptionId && check.subscriptionIds.includes(subscriptionId) ? subscriptionId : check.subscriptionIds[0];
          if (resolved !== subscriptionId) {
            await prisma.submission.update({ where: { id: submissionId }, data: { subscriptionId: resolved } });
            subscriptionId = resolved;
          }
        }
      }
      if (!subscriptionId) fail("No subscription found to attach the reward to.");

      // Single-discount providers (Recharge): replace the customer's current reward
      let replacedRewardId: string | undefined;
      if (isSingleDiscountProvider(shop.subscriptionProvider)) {
        const existing = await findActiveRewardToReplace({
          customerId: submission.customer.id,
          shopId: shop.id,
          subscriptionProvider: shop.subscriptionProvider,
        });
        if (existing && existing.rewardId !== submission.reward?.id) {
          console.log(
            `[UGME] Replacing existing reward ${existing.rewardId} ` +
              `(discount ${existing.externalDiscountId}) for new submission ${submissionId}`,
          );
          await provider.removeSubscriptionReward(ctx, {
            externalDiscountId: existing.externalDiscountId,
            externalTargetId: existing.rechargeChargeId,
          });
          await prisma.reward.update({ where: { id: existing.rewardId }, data: { status: "CREATED" } });
          replacedRewardId = existing.rewardId;
        }
      }

      const applied = await provider.applySubscriptionReward(ctx, {
        shopifyCustomerId,
        shopifyProductId: productId,
        subscriptionId: subscriptionId!,
        campaignTitle: campaign.title,
        submissionId,
        discountType: campaign.discountType as "FREE" | "FIXED_AMOUNT" | "PERCENTAGE",
        discountValue: campaign.discountValue,
        rewardCycles: campaign.rewardCycles,
      });
      fields = {
        externalDiscountId: applied.externalDiscountId,
        rechargeChargeId: applied.externalTargetId,
        rechargeSubscriptionId: subscriptionId,
        discountCode: applied.discountCode,
        discountProvider: shop.subscriptionProvider,
      };
      outcome = { status: "APPLIED", discountCode: applied.discountCode, replacedRewardId };
    }
  } catch (err) {
    const reason =
      err instanceof RewardFailure ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    if (!(err instanceof RewardFailure)) console.error("[UGME] Reward fulfilment failed:", err);
    outcome = { status: "FAILED", reason };
    fields = {
      discountProvider:
        campaign.rewardType === "DISCOUNT_CODE" ? "SHOPIFY_DISCOUNT_CODE" : shop.subscriptionProvider,
    };
  }

  const now = new Date();
  const data = {
    rewardType: campaign.rewardType,
    cycles: campaign.rewardCycles,
    status: outcome.status,
    appliedAt: outcome.status === "APPLIED" ? now : null,
    failureReason: outcome.status === "FAILED" ? outcome.reason ?? null : null,
    lastAttemptAt: now,
    ...fields,
  };
  await prisma.reward.upsert({
    where: { submissionId },
    update: { ...data, attemptCount: { increment: 1 } },
    create: { submissionId, customerId: submission.customer.id, attemptCount: 1, ...data },
  });

  // Tell the customer once the reward really exists (never blocks approval)
  if (outcome.status === "APPLIED") outcome.email = await sendRewardDeliveredEmail(submissionId);

  return outcome;
}
