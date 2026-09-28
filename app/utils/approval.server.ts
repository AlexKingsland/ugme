import prisma from "../db.server";
import {
  applyRewardToNextCharge,
  clearAddressDiscounts,
  deleteDiscount,
} from "./recharge.server";
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
 * For single-discount providers (e.g. Recharge), if the customer already
 * has an active reward, it is replaced: the old discount is cleared from
 * the address, deleted, and the old reward record is marked CREATED (no
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

  if (shop.providerConnected && shop.subscriptionProvider === "RECHARGE") {
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

            // Clear discount from address first
            if (existing.rechargeChargeId) {
              try {
                await clearAddressDiscounts(
                  parseInt(existing.rechargeChargeId, 10),
                  shop.providerApiKey || undefined
                );
              } catch (err) {
                console.warn(
                  "[UGME] Could not clear address discounts (may already be expired):",
                  err
                );
              }
            }

            // Delete the old discount from Recharge
            if (existing.externalDiscountId) {
              try {
                await deleteDiscount(
                  parseInt(existing.externalDiscountId, 10),
                  shop.providerApiKey || undefined
                );
              } catch (err) {
                console.warn(
                  "[UGME] Could not delete old discount (may already be gone):",
                  err
                );
              }
            }

            // Mark old reward as replaced in our DB
            await prisma.reward.update({
              where: { id: existing.rewardId },
              data: { status: "CREATED" }, // no longer APPLIED
            });

            replacedRewardId = existing.rewardId;
          }
        }

        // ── Apply the new reward ──
        const result = await applyRewardToNextCharge({
          shopifyCustomerId: submission.customer.shopifyCustomerId,
          shopifyProductId: submission.campaign.productId!,
          rechargeSubscriptionId: parseInt(submission.subscriptionId, 10),
          campaignTitle: submission.campaign.title,
          submissionId,
          discountType: submission.campaign.discountType as
            | "FREE"
            | "FIXED_AMOUNT"
            | "PERCENTAGE",
          discountValue: submission.campaign.discountValue,
          rewardCycles: submission.campaign.rewardCycles,
          token: shop.providerApiKey || undefined,
        });

        rewardStatus = "APPLIED";
        externalDiscountId = String(result.discountId);
        rechargeChargeId = String(result.addressId);
        discountCode = result.discountCode;
      } catch (err) {
        console.error("[UGME] Recharge reward application failed:", err);
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
