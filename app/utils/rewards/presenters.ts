/**
 * How each reward type is described to customers.
 *
 * One presenter per reward kind. Emails (and later the account page / admin)
 * render whatever the presenter returns, so adding a reward type = add a
 * `RewardDetails` variant + a presenter below. The `PRESENTERS` map is typed
 * over every kind, so TypeScript fails the build if a kind has no presenter.
 */

export type BillingFrequency = "DAY" | "WEEK" | "MONTH";
export type ValueType = "PERCENTAGE" | "FIXED_AMOUNT";

export type RewardDetails =
  /** No reward — the customer is featured on the brand's wall */
  | { kind: "FEATURED" }
  /** One-time: single-use Shopify discount code for the next order */
  | {
      kind: "DISCOUNT_CODE";
      code: string;
      valueType: ValueType;
      amount: number;
      minimumSubtotal?: number | null;
      expiresAt?: Date | null;
    }
  /** Subscription: discount on the next N billing periods (free / % / fixed) */
  | {
      kind: "SUBSCRIPTION_DISCOUNT";
      discountType: "FREE" | ValueType;
      value: number;
      cycles: number;
      frequency: BillingFrequency;
      code?: string | null;
    }
  /** One-time: credit added to the customer's Shopify account (not issued yet — presenter ready) */
  | {
      kind: "STORE_CREDIT";
      amount: number;
      expiresAt?: Date | null;
    };

export type RewardKind = RewardDetails["kind"];

export interface PresenterContext {
  shopUrl: string; // https://store.myshopify.com
  brandName?: string;
  accountUrl: string; // customer "My posts" page
  customerEmail: string;
  productTitle?: string | null;
  currency?: string; // ISO 4217, default USD
}

export interface RewardPresentation {
  /** Small caps label above the headline (default "Your reward") */
  cardLabel?: string;
  /** Heading of the steps list (default "How to use it") */
  stepsTitle?: string;
  /** Big line in the reward card, e.g. "$10 off" */
  headline: string;
  /** Line under it, e.g. "5 months of your subscription" */
  sub: string;
  /** Subject after "Your video was approved — " */
  subjectTail: string;
  /** Prominent code box (codes only) */
  code?: string;
  /** Short facts under the card: "Single use · Expires …" (plain text) */
  facts: string[];
  /** Sentence(s) under the headline inside the card (HTML, inputs escaped) */
  noteHtml?: string;
  /** Numbered "How to use it" steps (HTML, inputs escaped) */
  howToHtml: string[];
  cta: { label: string; url: string };
  /** Plain-text version of the reward section */
  text: string;
}

// ── helpers ─────────────────────────────────────────────────────
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

const PERIOD = {
  DAY: { one: "day", many: "days", adj: "daily" },
  WEEK: { one: "week", many: "weeks", adj: "weekly" },
  MONTH: { one: "month", many: "months", adj: "monthly" },
} as const;
export const periods = (n: number, f: BillingFrequency) => `${n} ${n === 1 ? PERIOD[f].one : PERIOD[f].many}`;

const valueText = (type: "FREE" | ValueType, value: number, currency?: string) =>
  type === "PERCENTAGE" ? `${value}% off` : type === "FIXED_AMOUNT" ? `${money(value, currency)} off` : "Free";

// ── presenters ──────────────────────────────────────────────────
type Presenter<K extends RewardKind> = (r: Extract<RewardDetails, { kind: K }>, ctx: PresenterContext) => RewardPresentation;

const discountCode: Presenter<"DISCOUNT_CODE"> = (r, ctx) => {
  const headline = valueText(r.valueType, r.amount, ctx.currency);
  const applyUrl = `${ctx.shopUrl}/discount/${encodeURIComponent(r.code)}?redirect=%2F`;
  const facts = [
    "Single use",
    `Works with your account (${ctx.customerEmail})`,
    r.minimumSubtotal ? `Minimum order ${money(r.minimumSubtotal, ctx.currency)}` : null,
    r.expiresAt ? `Expires ${fmtDate(r.expiresAt)}` : "No expiry date",
  ].filter(Boolean) as string[];
  return {
    headline,
    sub: "your next order",
    subjectTail: `here's ${headline} your next order`,
    code: r.code,
    facts,
    howToHtml: [
      `Tap <b>Shop now</b> below — the code is applied to your cart automatically.`,
      `Or enter <b>${esc(r.code)}</b> in the discount field at checkout.`,
      `Check out with the same email (${esc(ctx.customerEmail)}) — the code is tied to your account.`,
    ],
    cta: { label: "Shop now — code applied automatically", url: applyUrl },
    text: `Your reward: ${headline} your next order\nCode: ${r.code}\n${facts.join(" · ")}\n\nHow to use it:\n- Open ${applyUrl} — the code is applied automatically, or\n- enter ${r.code} at checkout, using the same email (${ctx.customerEmail}).`,
  };
};

const subscriptionDiscount: Presenter<"SUBSCRIPTION_DISCOUNT"> = (r, ctx) => {
  // Subscription rewards cover billing periods (e.g. 5 months of payments), not orders
  const span = periods(r.cycles, r.frequency);
  const adj = PERIOD[r.frequency].adj;
  const isFree = r.discountType === "FREE";
  const headline = isFree ? `${span} free` : valueText(r.discountType, r.value, ctx.currency);
  const sub = isFree ? "of your subscription" : `${span} of your subscription`;
  const product = ctx.productTitle || "your product";
  const payments = r.cycles === 1 ? `${adj} payment` : `${r.cycles} ${adj} payments`;
  return {
    headline,
    sub,
    subjectTail: isFree ? `${span} of your subscription free` : `${headline} ${span} of your subscription`,
    facts: [],
    noteHtml:
      `Already applied to your subscription for <b>${esc(product)}</b> — it starts automatically with your next ${adj} payment.` +
      (r.code ? ` You'll see <b style="font-family:ui-monospace,Menlo,monospace;">${esc(r.code)}</b> on your order summary.` : ""),
    howToHtml: [
      `Nothing to do — the discount is already on your subscription.`,
      `It covers your next ${payments} (${span}), then your normal price resumes.`,
      `Keep your subscription active so the discount can be used.`,
    ],
    cta: { label: "View your submission", url: ctx.accountUrl },
    text: `Your reward: ${headline} ${sub}\nIt's already applied to your subscription for ${product} and starts with your next ${adj} payment — nothing to do.${r.code ? `\nYou'll see ${r.code} on your order summary.` : ""}`,
  };
};

const storeCredit: Presenter<"STORE_CREDIT"> = (r, ctx) => {
  const amount = money(r.amount, ctx.currency);
  const facts = ["Added to your account", r.expiresAt ? `Expires ${fmtDate(r.expiresAt)}` : "No expiry date"];
  return {
    headline: `${amount} store credit`,
    sub: "to spend on anything in the store",
    subjectTail: `here's ${amount} in store credit`,
    facts,
    noteHtml: `It's already in your account (${esc(ctx.customerEmail)}).`,
    howToHtml: [
      `Sign in to your account when you shop.`,
      `At checkout, your store credit is offered as a payment option — apply as much as you like.`,
      `Anything left over stays in your account for next time.`,
    ],
    cta: { label: "Start shopping", url: ctx.shopUrl },
    text: `Your reward: ${amount} store credit\n${facts.join(" · ")}\n\nHow to use it: sign in with ${ctx.customerEmail} when you shop and apply your store credit at checkout.`,
  };
};

const featured: Presenter<"FEATURED"> = (_r, ctx) => {
  const brand = ctx.brandName || "the store";
  return {
    cardLabel: "You're on the wall",
    stepsTitle: "What happens next",
    headline: "Featured",
    sub: `on ${brand}'s Social Wall`,
    subjectTail: `you're featured on ${brand}'s Social Wall`,
    facts: ["Shown with a Verified buyer badge"],
    howToHtml: [
      `Your post now appears on the Social Wall in ${esc(brand)}'s store.`,
      `Shoppers can watch it and see the product you bought.`,
      `Share the store with friends so they can find you on the wall.`,
    ],
    cta: { label: "See the wall", url: ctx.shopUrl },
    text: `You're featured on ${brand}'s Social Wall. Shoppers can now see your post (with a Verified buyer badge) in the store: ${ctx.shopUrl}`,
  };
};

const PRESENTERS: { [K in RewardKind]: Presenter<K> } = {
  FEATURED: featured,
  DISCOUNT_CODE: discountCode,
  SUBSCRIPTION_DISCOUNT: subscriptionDiscount,
  STORE_CREDIT: storeCredit,
};

export function presentReward(reward: RewardDetails, ctx: PresenterContext): RewardPresentation {
  const presenter = PRESENTERS[reward.kind] as Presenter<typeof reward.kind>;
  return presenter(reward as never, ctx);
}

// ── merchant-facing short label (admin lists / banners) ─────────
export interface CampaignRewardFields {
  rewardType: string;
  // subscription
  discountType: string;
  discountValue: number;
  rewardCycles: number;
  rewardFrequency: string;
  // discount code
  discountCodeType?: string | null;
  discountCodeAmount?: number | null;
  // store credit
  storeCreditAmount?: number | null;
}

/** e.g. "25% off discount code", "$10 off × 3 months", "1 month free" */
export function campaignRewardLabel(c: CampaignRewardFields, currency = "USD"): string {
  if (c.rewardType === "NONE") return "Featured on the wall (no reward)";
  if (c.rewardType === "STORE_CREDIT") return `${money(Number(c.storeCreditAmount || 0), currency)} store credit`;
  if (c.rewardType === "DISCOUNT_CODE") {
    const amt = Number(c.discountCodeAmount || 0);
    const v = c.discountCodeType === "FIXED_AMOUNT" ? `${money(amt, currency)} off` : `${amt}% off`;
    return `${v} discount code`;
  }
  const f = (["DAY", "WEEK", "MONTH"].includes(c.rewardFrequency) ? c.rewardFrequency : "MONTH") as BillingFrequency;
  const span = periods(c.rewardCycles, f);
  if (c.discountType === "FREE") return `${span} free`;
  return `${valueText(c.discountType as ValueType, c.discountValue, currency)} × ${span}`;
}
