/**
 * Sales attribution — pure helpers (no DB), shared by the order webhooks and tests.
 *
 * The storefront wall leaves two hidden markers that Shopify carries onto the order:
 *  - Line item property `_social_wall` = "<campaignId>:<submissionId>"
 *    → the line was added with a wall post's "Add to cart" button  → DIRECT
 *  - Cart attribute `_social_wall_seen` = "<productId>:<submissionId>:<unixSecs>,…"
 *    → products of posts the shopper watched for a few seconds
 *    → a line for one of those products, ordered within 7 days    → INFLUENCED
 *  - The checkout web pixel sends the same views for "Buy it now" checkouts, which
 *    skip the cart (and its attribute) entirely.
 * Every other line — even in the same order — gets no credit.
 */

export const LINE_PROPERTY = "_social_wall";
export const SEEN_ATTRIBUTE = "_social_wall_seen";
export const INFLUENCE_WINDOW_SECS = 7 * 24 * 60 * 60;
/** Clock skew allowance between the shopper's device and Shopify */
const FUTURE_SLACK_SECS = 60 * 60;

export type SeenEntry = { productId: string; submissionId: string; t: number };

export type DirectTag = { campaignId: string; submissionId: string };

export type AttributedLine = {
  lineItemId: string;
  productId: string;
  productTitle: string | null;
  quantity: number;
  revenueCents: number;
  kind: "DIRECT" | "INFLUENCED";
  campaignId: string | null; // DIRECT: from the tag; INFLUENCED: resolved from the post later
  submissionId: string;
};

export type ParsedOrder = {
  orderId: string;
  orderName: string | null;
  orderedAt: Date;
  /** Calendar day in the shop's time zone (Shopify sends created_at with the shop's offset) */
  day: string;
  currency: string;
  revenueCents: number;
  test: boolean;
  lines: AttributedLine[];
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NUM = /^\d{1,20}$/;

export function toCents(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** "gid://shopify/Product/123" | "123" → "123" */
export function numericId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = s.match(/(\d+)$/);
  return m ? m[1] : null;
}

export function parseDirectTag(value: unknown): DirectTag | null {
  const [campaignId, submissionId, ...rest] = String(value ?? "").trim().split(":");
  if (rest.length || !campaignId || !submissionId || !ID.test(campaignId) || !ID.test(submissionId)) return null;
  return { campaignId, submissionId };
}

export function parseSeen(value: unknown): SeenEntry[] {
  const out: SeenEntry[] = [];
  for (const part of String(value ?? "").split(",")) {
    const [productId, submissionId, t, ...rest] = part.trim().split(":");
    if (rest.length || !NUM.test(productId || "") || !ID.test(submissionId || "") || !NUM.test(t || "")) continue;
    out.push({ productId, submissionId, t: Number(t) });
  }
  return out;
}

export function encodeSeen(entries: SeenEntry[]): string {
  return entries.map((e) => `${e.productId}:${e.submissionId}:${e.t}`).join(",");
}

function attr(list: unknown, name: string): string | null {
  if (!Array.isArray(list)) return null;
  const hit = list.find((a: any) => a && String(a.name) === name);
  return hit ? String(hit.value ?? "") : null;
}

function shopMoney(set: any, fallback: unknown): number {
  const amount = set?.shop_money?.amount;
  return toCents(amount ?? fallback);
}

/** The most recent qualifying view of `productId` before the order. */
export function influencingView(seen: SeenEntry[], productId: string, orderedAtSecs: number): SeenEntry | null {
  let best: SeenEntry | null = null;
  for (const e of seen) {
    if (e.productId !== productId) continue;
    if (e.t > orderedAtSecs + FUTURE_SLACK_SECS) continue; // from the future → ignore
    if (orderedAtSecs - e.t > INFLUENCE_WINDOW_SECS) continue; // older than 7 days
    if (!best || e.t > best.t) best = e;
  }
  return best;
}

/** Every product line of an order, kept so views that arrive later (checkout pixel) can still be credited. */
export type OrderLine = {
  lineItemId: string;
  productId: string;
  productTitle: string | null;
  quantity: number;
  revenueCents: number;
  direct: DirectTag | null;
};

/** Decide credit per line: DIRECT tag first, else INFLUENCED by a qualifying view, else nothing. */
export function attributeLines(lines: OrderLine[], seen: SeenEntry[], orderedAtSecs: number): AttributedLine[] {
  const out: AttributedLine[] = [];
  for (const l of lines) {
    const base = { lineItemId: l.lineItemId, productId: l.productId, productTitle: l.productTitle, quantity: l.quantity, revenueCents: l.revenueCents };
    if (l.direct) {
      out.push({ ...base, kind: "DIRECT", campaignId: l.direct.campaignId, submissionId: l.direct.submissionId });
      continue;
    }
    const view = influencingView(seen, l.productId, orderedAtSecs);
    if (view) out.push({ ...base, kind: "INFLUENCED", campaignId: null, submissionId: view.submissionId });
  }
  return out;
}

/** REST-format order webhook payload → what we store. `extraSeen`: views reported by the checkout pixel. */
export function parseOrder(order: any, extraSeen: SeenEntry[] = []): (ParsedOrder & { allLines: OrderLine[]; seen: SeenEntry[] }) | null {
  const orderId = numericId(order?.id);
  if (!orderId) return null;
  const orderedAt = new Date(order.created_at || order.processed_at || Date.now());
  const orderedAtSecs = Math.floor(orderedAt.getTime() / 1000);
  const seen = [...parseSeen(attr(order.note_attributes, SEEN_ATTRIBUTE)), ...extraSeen];

  const allLines: OrderLine[] = [];
  for (const li of Array.isArray(order.line_items) ? order.line_items : []) {
    const productId = numericId(li?.product_id);
    const lineItemId = numericId(li?.id);
    if (!productId || !lineItemId) continue; // custom items, gift cards without a product
    const quantity = Math.max(0, Number(li.quantity) || 0);
    if (!quantity) continue;
    const gross = shopMoney(li.price_set, li.price) * quantity;
    const discounts = (Array.isArray(li.discount_allocations) ? li.discount_allocations : []).reduce(
      (sum: number, d: any) => sum + shopMoney(d?.amount_set, d?.amount),
      0,
    );
    allLines.push({
      lineItemId,
      productId,
      productTitle: li.title ? String(li.title) : null,
      quantity,
      revenueCents: Math.max(0, gross - discounts),
      direct: parseDirectTag(attr(li.properties, LINE_PROPERTY)),
    });
  }

  const localDay = String(order.created_at || "").match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  return {
    orderId,
    orderName: order.name ? String(order.name) : null,
    orderedAt,
    day: localDay || orderedAt.toISOString().slice(0, 10),
    currency: String(order.subtotal_price_set?.shop_money?.currency_code || order.currency || "USD"),
    revenueCents: shopMoney(order.subtotal_price_set, order.subtotal_price),
    test: order.test === true,
    lines: attributeLines(allLines, seen, orderedAtSecs),
    allLines,
    seen,
  };
}

/** Views as the storefront keeps them in localStorage: [{ p, s, t }] (sent by the checkout pixel). */
export function parsePixelSeen(value: unknown): SeenEntry[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return parseSeen(
    raw
      .slice(0, 50)
      .map((e: any) => `${e?.p}:${e?.s}:${Math.floor(Number(e?.t))}`)
      .join(","),
  );
}

export type ParsedRefund = {
  refundId: string;
  orderId: string;
  lines: { lineItemId: string; cents: number }[];
  totalCents: number;
};

/** REST-format refunds/create payload → refunded amounts per line (excl. shipping/tax). */
export function parseRefund(refund: any): ParsedRefund | null {
  const refundId = numericId(refund?.id);
  const orderId = numericId(refund?.order_id);
  if (!refundId || !orderId) return null;
  const lines = (Array.isArray(refund.refund_line_items) ? refund.refund_line_items : [])
    .map((r: any) => ({
      lineItemId: numericId(r?.line_item_id) || "",
      cents: Math.max(0, shopMoney(r?.subtotal_set, r?.subtotal)),
    }))
    .filter((r: { lineItemId: string; cents: number }) => r.lineItemId && r.cents > 0);
  return { refundId, orderId, lines, totalCents: lines.reduce((s: number, l: { cents: number }) => s + l.cents, 0) };
}
