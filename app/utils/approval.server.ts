import prisma from "../db.server";
import { checkSubmissionLimit, type PlanTierKey } from "./plans.server";
import type { SubscriptionProvider } from "@prisma/client";
import type { AdminGraphqlClient } from "./providers";
import { fulfillReward } from "./rewards.server";
import { onSubmissionApproved } from "./public-media.server";

export interface ApprovalResult {
  rewardStatus: "CREATED" | "APPLIED" | "FAILED";
  rewardError?: string;
  /** If a previous reward was replaced, its ID */
  replacedRewardId?: string;
  /** Discount code issued (DISCOUNT_CODE campaigns) */
  discountCode?: string | null;
}

/**
 * Shared approval logic: approve a submission and deliver the reward.
 * Called from both the library list view and the detail view.
 *
 * Reward delivery lives in rewards.server.ts (fulfillReward), which records
 * success/failure on the Reward row. Failed rewards are retried internally
 * with scripts/retry-rewards.ts — not by the merchant.
 */
/**
 * Merchant-facing wording. Known, actionable reasons (provider not connected,
 * customer cancelled, campaign misconfigured…) are shown as-is; unexpected
 * API errors stay internal (Reward.failureReason) and are retried by us.
 */
function merchantMessage(reason?: string): string {
  if (reason?.startsWith("UNCERTAIN")) {
    return "Approved — we couldn't confirm the store credit went through. We'll check it before trying again, so the customer is never credited twice.";
  }
  if (!reason || reason.startsWith("Unexpected error")) {
    return "Approved — but the reward couldn't be delivered right now. We've logged it and will retry it for you.";
  }
  return `Approved — but the reward couldn't be delivered: ${reason}`;
}

/** Thrown when the plan's monthly approval limit is reached. */
export class ApprovalLimitError extends Error {
  constructor(readonly used: number, readonly limit: number) {
    super(`You've used all ${limit} approvals included in your plan this month. Upgrade your plan to approve more — this submission stays pending until then.`);
  }
}

export async function approveSubmission(params: {
  submissionId: string;
  shop: {
    id: string;
    subscriptionProvider: SubscriptionProvider;
    providerApiKey: string | null;
    providerConnected: boolean;
  };
  /** Shopify Admin API client from authenticate.admin — needed for discount codes. */
  admin?: AdminGraphqlClient;
}): Promise<ApprovalResult> {
  const { submissionId, shop, admin } = params;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { campaign: { select: { shopId: true } } },
  });
  if (!submission || submission.campaign.shopId !== shop.id) {
    throw new Error("Submission not found or does not belong to this shop");
  }

  // Monthly limit = approved submissions this month (re-approving an approved one is free)
  if (submission.status !== "APPROVED") {
    const shopRow = await prisma.shop.findUnique({ where: { id: shop.id }, select: { planTier: true } });
    const limit = await checkSubmissionLimit(shop.id, ((shopRow?.planTier as PlanTierKey) || "FREE"));
    if (!limit.ok) throw new ApprovalLimitError(limit.used, limit.limit);
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

  const outcome = await fulfillReward({ submissionId, shop, admin });

  // Publish to the CDN + refresh the wall's post list (never blocks approval)
  await onSubmissionApproved(submissionId);

  return {
    rewardStatus: outcome.status,
    ...(outcome.status === "FAILED" ? { rewardError: merchantMessage(outcome.reason) } : {}),
    replacedRewardId: outcome.replacedRewardId,
    discountCode: outcome.discountCode,
  };
}
