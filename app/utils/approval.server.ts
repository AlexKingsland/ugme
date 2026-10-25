import prisma from "../db.server";
import { getProviderAdapter } from "./providers";
import {
  isSingleDiscountProvider,
  findActiveRewardToReplace,
} from "./reward-gating.server";
import type { SubscriptionProvider } from "@prisma/client";

export interface ApprovalResult {
  rewardStatus: "CREATED" | "APPLIED" | "FAILED";
  rewardError?: string;
  /** If a previous reward was replaced, its ID */
  replacedRewardId?: string;
}

/**
 * Shared approval logic: approve a submission and apply the reward.
 * Called from both the library list view and the detail view.
 *
 * Provider-specific work goes through the subscription provider adapter
 * (app/utils/providers). For single-discount providers (e.g. Recharge), if
 * the customer already has an active reward, it is replaced: the adapter
 * removes the old discount and the old reward record is marked CREATED (no
 * longer applied). Then the new discount is applied.
 */
export async function approveSubmission(params: {
  submissionId: string;
  shop: {
    id: string;
    subscriptionProvider: SubscriptionProvider;
    providerApiKey: string | null;
    providerConnected: boolean;
  };
}): Promise<ApprovalResult> {
  const { submissionId, shop } = params;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      campaign: true,
      customer: { select: { id: true, shopifyCustomerId: true } },
    },
  });

  if (!submission || submission.campaign.shopId !== shop.id) {
    throw new Error("Submission not found or does not belong to this shop");
  }

  // Mark submission as approved
  await prisma.submission.update({
    where: { id: submissionId },
    data: {
      status: "APPROVED",
      reviewedAt: new Date(),
      rightsAccepted: true,
      usageTags: JSON.stringify(["Social + Product Pages"]),
    },
  });

  let rewardStatus: "CREATED" | "APPLIED" | "FAILED" = "CREATED";
  let externalDiscountId: string | null = null;
  let rechargeChargeId: string | null = null;
  let discountCode: string | null = null;
  let replacedRewardId: string | undefined;

  const provider = getProviderAdapter(shop.subscriptionProvider);
  const providerCtx = { apiKey: shop.providerApiKey };

  if (shop.providerConnected && provider.capabilities.subscriptionDiscount.supported) {
    if (submission.customer.shopifyCustomerId && submission.subscriptionId) {
      try {
        // ── Replace existing reward if on a single-discount provider ──
        if (isSingleDiscountProvider(shop.subscriptionProvider)) {
          const existing = await findActiveRewardToReplace({
            customerId: submission.customer.id,
            shopId: shop.id,
            subscriptionProvider: shop.subscriptionProvider,
          });

          if (existing) {
            console.log(
              `[UGME] Replacing existing reward ${existing.rewardId} ` +
                `(discount ${existing.externalDiscountId}) for new submission ${submissionId}`
            );

            // Remove the old discount from the provider (best-effort)
            await provider.removeSubscriptionReward(providerCtx, {
              externalDiscountId: existing.externalDiscountId,
              externalTargetId: existing.rechargeChargeId,
            });

            // Mark old reward as replaced in our DB
            await prisma.reward.update({
              where: { id: existing.rewardId },
              data: { status: "CREATED" }, // no longer APPLIED
            });

            replacedRewardId = existing.rewardId;
          }
        }

        // ── Apply the new reward ──
        const result = await provider.applySubscriptionReward(providerCtx, {
          shopifyCustomerId: submission.customer.shopifyCustomerId,
          shopifyProductId: submission.campaign.productId!,
          subscriptionId: submission.subscriptionId,
          campaignTitle: submission.campaign.title,
          submissionId,
          discountType: submission.campaign.discountType as
            | "FREE"
            | "FIXED_AMOUNT"
            | "PERCENTAGE",
          discountValue: submission.campaign.discountValue,
          rewardCycles: submission.campaign.rewardCycles,
        });

        rewardStatus = "APPLIED";
        externalDiscountId = result.externalDiscountId;
        rechargeChargeId = result.externalTargetId;
        discountCode = result.discountCode;
      } catch (err) {
        console.error(`[UGME] ${provider.displayName} reward application failed:`, err);
        rewardStatus = "FAILED";
      }
    }
  }

  await prisma.reward.upsert({
    where: { submissionId },
    update: {
      status: rewardStatus,
      appliedAt: rewardStatus === "APPLIED" ? new Date() : null,
      externalDiscountId,
      rechargeChargeId,
      rechargeSubscriptionId: submission.subscriptionId || null,
      discountCode,
    },
    create: {
      submissionId,
      customerId: submission.customer.id,
      cycles: submission.campaign.rewardCycles,
      discountProvider: shop.subscriptionProvider,
      status: rewardStatus,
      appliedAt: rewardStatus === "APPLIED" ? new Date() : null,
      externalDiscountId,
      rechargeChargeId,
      rechargeSubscriptionId: submission.subscriptionId || null,
      discountCode,
    },
  });

  return {
    rewardStatus,
    ...(rewardStatus === "FAILED"
      ? { rewardError: "Could not apply discount to next charge" }
      : {}),
    replacedRewardId,
  };
}
