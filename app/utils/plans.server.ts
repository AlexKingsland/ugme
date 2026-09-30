import prisma from "../db.server";

/**
 * Plan tier definitions and gating logic for UGME billing.
 *
 * Tiers:
 *   FREE       — 500 MB storage, 10 submissions/month
 *   STARTER    — 10 GB storage, 500 submissions/month
 *   PRO        — 100 GB storage, 5000 submissions/month
 *   ENTERPRISE — unlimited (contact for pricing)
 */

export type PlanTierKey = "FREE" | "STARTER" | "PRO" | "ENTERPRISE";

export interface PlanDefinition {
  key: PlanTierKey;
  name: string;
  /** Monthly price in USD (0 = free, -1 = contact) */
  priceMonthly: number;
  /** Storage limit in bytes */
  storageBytes: number;
  /** Max submissions per calendar month */
  submissionsPerMonth: number;
  /** Human-readable storage label */
  storageLabel: string;
  /** Human-readable submission label */
  submissionLabel: string;
  features: string[];
}

export const PLAN_DEFINITIONS: Record<PlanTierKey, PlanDefinition> = {
  FREE: {
    key: "FREE",
    name: "Free",
    priceMonthly: 0,
    storageBytes: 500 * 1024 * 1024, // 500 MB
    submissionsPerMonth: 10,
    storageLabel: "500 MB",
    submissionLabel: "10 / month",
    features: [
      "1 active campaign",
      "Basic submission portal",
      "Manual approval workflow",
      "Email notifications",
    ],
  },
  STARTER: {
    key: "STARTER",
    name: "Starter",
    priceMonthly: 29,
    storageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    submissionsPerMonth: 500,
    storageLabel: "10 GB",
    submissionLabel: "500 / month",
    features: [
      "Unlimited campaigns",
      "Custom branding",
      "Priority support",
      "Usage analytics",
    ],
  },
  PRO: {
    key: "PRO",
    name: "Pro",
    priceMonthly: 99,
    storageBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    submissionsPerMonth: 5000,
    storageLabel: "100 GB",
    submissionLabel: "5,000 / month",
    features: [
      "Everything in Starter",
      "Bulk actions & exports",
      "Advanced analytics",
      "API access",
    ],
  },
  ENTERPRISE: {
    key: "ENTERPRISE",
    name: "Enterprise",
    priceMonthly: -1, // contact
    storageBytes: Infinity,
    submissionsPerMonth: Infinity,
    storageLabel: "Unlimited",
    submissionLabel: "Unlimited",
    features: [
      "Everything in Pro",
      "Dedicated account manager",
      "Custom integrations",
      "SLA & uptime guarantee",
    ],
  },
};

/** Get the plan definition for a tier key */
export function getPlan(tier: PlanTierKey): PlanDefinition {
  return PLAN_DEFINITIONS[tier] || PLAN_DEFINITIONS.FREE;
}

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

/** Check submissions this calendar month vs plan limit. Returns { used, limit, ok } */
export async function checkSubmissionLimit(shopId: string, planTier: PlanTierKey) {
  const plan = getPlan(planTier);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const count = await prisma.submission.count({
    where: {
      campaign: { shopId },
      createdAt: { gte: monthStart },
    },
  });
  return {
    used: count,
    limit: plan.submissionsPerMonth,
    ok: count < plan.submissionsPerMonth,
    pct: plan.submissionsPerMonth === Infinity ? 0 : Math.min((count / plan.submissionsPerMonth) * 100, 100),
  };
}

/** Combined gate check — returns which limits are hit (if any) */
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
    canAcceptSubmission: !wouldExceedStorage && submissions.ok,
    blockedReasons: [
      ...(wouldExceedStorage ? ["Storage limit reached"] : []),
      ...(!submissions.ok ? ["Monthly submission limit reached"] : []),
    ],
  };
}

export { formatBytes } from "./format";
