/**
 * Plan definitions + pure helpers — shared by server and browser code.
 * Usage checks that touch the database live in plans.server.ts.
 */
/*
 * Social Wall plans. Every plan includes the full app — the wall (no branding),
 * unlimited wall campaigns, verified-buyer posts, rewards and sales analytics.
 * Plans differ only in approved posts and storage:
 *
 *   FREE       — $0      2 GB      50 approved in total (never resets; deleting a post frees its slot)
 *   STARTER    — $7.99   10 GB     500 approved / month   (shown as "Standard")
 *   PRO        — $21.99  100 GB    unlimited approvals
 *   ENTERPRISE — hidden; assigned by hand for special arrangements
 *
 * The STARTER key is kept (DB enum) — only its display name changed.
 */

export type PlanTierKey = "FREE" | "STARTER" | "PRO" | "ENTERPRISE";

export interface PlanDefinition {
  key: PlanTierKey;
  name: string;
  /** Monthly price in USD (0 = free, -1 = custom) */
  priceMonthly: number;
  /** Storage limit in bytes */
  storageBytes: number;
  /** Max APPROVED submissions — per calendar month, or in total (see approvalPeriod) */
  submissionsPerMonth: number;
  /** "month": the limit resets each month. "total": approved posts that exist, never resets. */
  approvalPeriod: "month" | "total";
  /** Human-readable storage label */
  storageLabel: string;
  /** Human-readable submission label */
  submissionLabel: string;
  features: string[];
  /** Not offered on the billing page */
  hidden?: boolean;
  /** Order on the billing page (upgrade vs downgrade) */
  rank: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Same on every plan — the plans differ only in limits. */
const INCLUDED = [
  "Social Wall theme block (no branding)",
  "Unlimited wall campaigns",
  "Verified-buyer posts with usage rights",
  "Discount code & store credit rewards",
  "Sales analytics (direct + influenced)",
];

export const PLAN_DEFINITIONS: Record<PlanTierKey, PlanDefinition> = {
  FREE: {
    key: "FREE",
    name: "Free",
    priceMonthly: 0,
    storageBytes: 2 * GB,
    submissionsPerMonth: 50,
    approvalPeriod: "total",
    storageLabel: "2 GB",
    submissionLabel: "50 in total",
    features: INCLUDED,
    rank: 0,
  },
  STARTER: {
    key: "STARTER",
    name: "Standard",
    priceMonthly: 7.99,
    storageBytes: 10 * GB,
    submissionsPerMonth: 500,
    approvalPeriod: "month",
    storageLabel: "10 GB",
    submissionLabel: "500 / month",
    features: INCLUDED,
    rank: 1,
  },
  PRO: {
    key: "PRO",
    name: "Pro",
    priceMonthly: 21.99,
    storageBytes: 100 * GB,
    submissionsPerMonth: Infinity,
    approvalPeriod: "month",
    storageLabel: "100 GB",
    submissionLabel: "Unlimited",
    features: INCLUDED,
    rank: 2,
  },
  ENTERPRISE: {
    key: "ENTERPRISE",
    name: "Enterprise",
    priceMonthly: -1,
    storageBytes: Infinity,
    submissionsPerMonth: Infinity,
    approvalPeriod: "month",
    storageLabel: "Unlimited",
    submissionLabel: "Unlimited",
    features: INCLUDED,
    hidden: true,
    rank: 3,
  },
};

/** Display price: "$7.99" / "Free" / "Custom" */
export function formatPlanPrice(plan: PlanDefinition): string {
  if (plan.priceMonthly < 0) return "Custom";
  if (plan.priceMonthly === 0) return "Free";
  return `$${plan.priceMonthly.toFixed(2)}`;
}

/** "this month" / "in total" — how the plan's approval limit is counted, for sentences. */
export function approvalScope(plan: Pick<PlanDefinition, "approvalPeriod">): string {
  return plan.approvalPeriod === "total" ? "in total" : "this month";
}

/** Get the plan definition for a tier key */
export function getPlan(tier: PlanTierKey): PlanDefinition {
  return PLAN_DEFINITIONS[tier] || PLAN_DEFINITIONS.FREE;
}

