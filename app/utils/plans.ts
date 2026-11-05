/**
 * Plan definitions + pure helpers — shared by server and browser code.
 * Usage checks that touch the database live in plans.server.ts.
 */
/*
 * Social Wall plans. Every plan includes the full app — the wall (no branding),
 * unlimited wall campaigns, verified-buyer posts, rewards and sales analytics.
 * Plans differ only in approved posts per month and storage:
 *
 *   FREE       — $0      250 MB    10 approved / month
 *   STARTER    — $7.99   10 GB     100 approved / month   (shown as "Standard")
 *   PRO        — $21.99  100 GB    1,000 approved / month
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
  /** Max APPROVED submissions per calendar month */
  submissionsPerMonth: number;
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
    storageBytes: 250 * MB,
    submissionsPerMonth: 10,
    storageLabel: "250 MB",
    submissionLabel: "10 / month",
    features: INCLUDED,
    rank: 0,
  },
  STARTER: {
    key: "STARTER",
    name: "Standard",
    priceMonthly: 7.99,
    storageBytes: 10 * GB,
    submissionsPerMonth: 100,
    storageLabel: "10 GB",
    submissionLabel: "100 / month",
    features: INCLUDED,
    rank: 1,
  },
  PRO: {
    key: "PRO",
    name: "Pro",
    priceMonthly: 21.99,
    storageBytes: 100 * GB,
    submissionsPerMonth: 1000,
    storageLabel: "100 GB",
    submissionLabel: "1,000 / month",
    features: INCLUDED,
    rank: 2,
  },
  ENTERPRISE: {
    key: "ENTERPRISE",
    name: "Enterprise",
    priceMonthly: -1,
    storageBytes: Infinity,
    submissionsPerMonth: Infinity,
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

/** Get the plan definition for a tier key */
export function getPlan(tier: PlanTierKey): PlanDefinition {
  return PLAN_DEFINITIONS[tier] || PLAN_DEFINITIONS.FREE;
}

