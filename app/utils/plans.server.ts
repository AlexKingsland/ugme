import prisma from "../db.server";

export { PLAN_DEFINITIONS, getPlan, formatPlanPrice } from "./plans";
export type { PlanTierKey, PlanDefinition } from "./plans";
import { getPlan, type PlanTierKey } from "./plans";

/** Check current storage usage vs plan limit. Returns { used, limit, ok } */
export async function checkStorageLimit(shopId: string, planTier: PlanTierKey) {
  const plan = getPlan(planTier);
  const agg = await prisma.submission.aggregate({
    where: { campaign: { shopId } },
    _sum: { fileBytes: true },
  });
  const used = agg._sum.fileBytes || 0;
  return {
    usedBytes: used,
    limitBytes: plan.storageBytes,
    ok: used < plan.storageBytes,
    pct: plan.storageBytes === Infinity ? 0 : Math.min((used / plan.storageBytes) * 100, 100),
  };
}

/**
 * APPROVED submissions this calendar month vs the plan's monthly limit.
 * Pending and rejected submissions never count — the limit is applied when
 * the merchant approves, not when customers upload.
 */
export async function checkSubmissionLimit(shopId: string, planTier: PlanTierKey) {
  const plan = getPlan(planTier);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // "total" plans count approved posts that still exist (deleting one frees its slot)
  const count = await prisma.submission.count({
    where: {
      campaign: { shopId },
      status: "APPROVED",
      ...(plan.approvalPeriod === "month" ? { reviewedAt: { gte: monthStart } } : {}),
    },
  });
  return {
    period: plan.approvalPeriod,
    used: count,
    limit: plan.submissionsPerMonth,
    ok: count < plan.submissionsPerMonth,
    pct: plan.submissionsPerMonth === Infinity ? 0 : Math.min((count / plan.submissionsPerMonth) * 100, 100),
  };
}

/**
 * Upload gate. Customers can always submit while there's storage left; the
 * monthly limit only applies to approvals (see checkSubmissionLimit).
 */
export async function checkPlanGates(shopId: string, planTier: PlanTierKey, additionalBytes?: number) {
  const [storage, submissions] = await Promise.all([
    checkStorageLimit(shopId, planTier),
    checkSubmissionLimit(shopId, planTier),
  ]);

  // Check if adding additionalBytes would exceed storage
  const wouldExceedStorage = additionalBytes
    ? (storage.usedBytes + additionalBytes) > storage.limitBytes
    : !storage.ok;

  return {
    storage,
    submissions,
    canAcceptSubmission: !wouldExceedStorage,
    blockedReasons: [...(wouldExceedStorage ? ["Storage limit reached"] : [])],
  };
}

export { formatBytes } from "./format";
