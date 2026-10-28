import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  attributeLines,
  encodeSeen,
  numericId,
  parseOrder,
  parseRefund,
  parseSeen,
  type AttributedLine,
  type OrderLine,
  type SeenEntry,
} from "./attribution";

/**
 * Sales attribution storage + reporting.
 *
 * Scale: the dashboard never scans orders. Every write (order, pixel report, refund)
 * also bumps two small rollup tables — one row per shop per day, and one per post per
 * day it earned anything — so a 90-day report reads ≤ 90 rows regardless of order
 * volume. Order rows stay (refunds need them), but their full line list is only kept
 * for the few hours a checkout-pixel report can still arrive.
 */

/** The checkout pixel must report within this long of the order being placed. */
const PIXEL_REPORT_WINDOW_MS = 6 * 60 * 60 * 1000;
const PIXEL_VIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** Test orders count in development (dev stores only take test orders), never in production. */
export const COUNT_TEST_ORDERS = process.env.NODE_ENV !== "production";

type Tx = Prisma.TransactionClient;
type PostInfo = { campaignId: string; productIds: Set<string> };

/** Posts referenced by an order, limited to this shop's wall campaigns. */
async function loadPosts(shopId: string, submissionIds: string[]): Promise<Map<string, PostInfo>> {
  const map = new Map<string, PostInfo>();
  if (!submissionIds.length) return map;
  const rows = await prisma.submission.findMany({
    where: { id: { in: [...new Set(submissionIds)] }, campaign: { shopId } },
    select: { id: true, campaignId: true, products: true },
  });
  for (const r of rows) {
    let ids: string[] = [];
    try {
      ids = (JSON.parse(r.products || "[]") as { id: string }[]).map((p) => numericId(p.id) || "").filter(Boolean);
    } catch {}
    map.set(r.id, { campaignId: r.campaignId, productIds: new Set(ids) });
  }
  return map;
}

/**
 * Only keep credit the wall really earned: the post must belong to this shop and
 * the line's product must be one of that post's linked products.
 */
export function verifyLines(lines: AttributedLine[], posts: Map<string, PostInfo>): AttributedLine[] {
  const out: AttributedLine[] = [];
  for (const l of lines) {
    const post = posts.get(l.submissionId);
    if (!post || !post.productIds.has(l.productId)) continue;
    if (l.kind === "DIRECT" && l.campaignId !== post.campaignId) continue;
    out.push({ ...l, campaignId: post.campaignId });
  }
  return out;
}

// ── Rollups ──────────────────────────────────────────────────────

type DayDelta = { total?: number; direct?: number; influenced?: number; directOrders?: number; influencedOrders?: number };
type PostDelta = { submissionId: string; campaignId: string | null; direct: number; influenced: number };

/** Add (or subtract) amounts on a shop's day row and its posts' day rows. */
async function bump(tx: Tx, shopId: string, day: string, currency: string, d: DayDelta, posts: PostDelta[] = []) {
  const inc = {
    totalCents: { increment: d.total || 0 },
    directCents: { increment: d.direct || 0 },
    influencedCents: { increment: d.influenced || 0 },
    directOrders: { increment: d.directOrders || 0 },
    influencedOrders: { increment: d.influencedOrders || 0 },
  };
  await tx.wallDailyStat.upsert({
    where: { shopId_day: { shopId, day } },
    update: inc,
    create: {
      shopId, day, currency,
      totalCents: d.total || 0, directCents: d.direct || 0, influencedCents: d.influenced || 0,
      directOrders: d.directOrders || 0, influencedOrders: d.influencedOrders || 0,
    },
  });
  // Merge per post first (an order can have several lines from the same post)
  const merged = new Map<string, PostDelta>();
  for (const p of posts) {
    const m = merged.get(p.submissionId) || { ...p, direct: 0, influenced: 0 };
    m.direct += p.direct;
    m.influenced += p.influenced;
    merged.set(p.submissionId, m);
  }
  for (const p of merged.values()) {
    if (!p.direct && !p.influenced) continue;
    await tx.wallPostDailyStat.upsert({
      where: { shopId_day_submissionId: { shopId, day, submissionId: p.submissionId } },
      update: { directCents: { increment: p.direct }, influencedCents: { increment: p.influenced } },
      create: { shopId, day, submissionId: p.submissionId, campaignId: p.campaignId, directCents: p.direct, influencedCents: p.influenced },
    });
  }
}

function lineDeltas(lines: { kind: string; submissionId: string | null; campaignId: string | null; cents: number }[]) {
  let direct = 0, influenced = 0;
  const posts: PostDelta[] = [];
  for (const l of lines) {
    const isDirect = l.kind === "DIRECT";
    if (isDirect) direct += l.cents; else influenced += l.cents;
    if (l.submissionId) posts.push({ submissionId: l.submissionId, campaignId: l.campaignId, direct: isDirect ? l.cents : 0, influenced: isDirect ? 0 : l.cents });
  }
  return { direct, influenced, posts };
}

// ── Housekeeping (throttled, never blocks a webhook on failure) ──

let lastPrune = 0;
function maybePrune() {
  if (Date.now() - lastPrune < 10 * 60 * 1000) return;
  lastPrune = Date.now();
  const linesCutoff = new Date(Date.now() - PIXEL_REPORT_WINDOW_MS);
  const viewsCutoff = new Date(Date.now() - PIXEL_VIEW_TTL_MS);
  Promise.all([
    // the full line list is only needed while a pixel report can still arrive
    prisma.wallOrder.updateMany({ where: { orderedAt: { lt: linesCutoff }, linesJson: { not: "[]" } }, data: { linesJson: "[]" } }),
    // pixel reports for orders that never reached us (other apps' test checkouts, etc.)
    prisma.wallPixelView.deleteMany({ where: { createdAt: { lt: viewsCutoff } } }),
  ]).catch((err) => console.warn("[sales] prune failed:", err));
}

// ── Webhooks ─────────────────────────────────────────────────────

/** orders/create — idempotent (Shopify may deliver a webhook more than once). */
export async function recordOrder(shopDomain: string, payload: unknown) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return { skipped: "unknown shop" as const };
  maybePrune();
  const orderIdPeek = numericId((payload as any)?.id);
  // Views the checkout pixel reported before this webhook arrived ("Buy it now" checkouts)
  const pixel = orderIdPeek
    ? await prisma.wallPixelView.findUnique({ where: { shopId_orderId: { shopId: shop.id, orderId: orderIdPeek } }, select: { seen: true } })
    : null;
  const parsed = parseOrder(payload, pixel ? parseSeen(pixel.seen) : []);
  if (!parsed) return { skipped: "bad payload" as const };

  const existing = await prisma.wallOrder.findUnique({
    where: { shopId_orderId: { shopId: shop.id, orderId: parsed.orderId } },
    select: { id: true },
  });
  if (existing) return { skipped: "duplicate" as const };

  const posts = await loadPosts(shop.id, parsed.lines.map((l) => l.submissionId));
  const lines = verifyLines(parsed.lines, posts);
  const counted = COUNT_TEST_ORDERS || !parsed.test;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.wallOrder.create({
        data: {
          shopId: shop.id,
          orderId: parsed.orderId,
          orderName: parsed.orderName,
          orderedAt: parsed.orderedAt,
          day: parsed.day,
          currency: parsed.currency,
          revenueCents: parsed.revenueCents,
          test: parsed.test,
          counted,
          linesJson: JSON.stringify(parsed.allLines),
          lines: {
            create: lines.map((l) => ({
              lineItemId: l.lineItemId,
              productId: l.productId,
              productTitle: l.productTitle,
              kind: l.kind,
              campaignId: l.campaignId,
              submissionId: l.submissionId,
              quantity: l.quantity,
              revenueCents: l.revenueCents,
            })),
          },
        },
      });
      if (!counted) return;
      const d = lineDeltas(lines.map((l) => ({ ...l, cents: l.revenueCents })));
      await bump(tx, shop.id, parsed.day, parsed.currency, {
        total: parsed.revenueCents,
        direct: d.direct,
        influenced: d.influenced,
        directOrders: lines.some((l) => l.kind === "DIRECT") ? 1 : 0,
        influencedOrders: lines.some((l) => l.kind === "INFLUENCED") ? 1 : 0,
      }, d.posts);
    });
  } catch (err: any) {
    if (err?.code === "P2002") return { skipped: "duplicate" as const }; // concurrent redelivery
    throw err;
  }
  return { recorded: true as const, attributedLines: lines.length };
}

/**
 * Checkout web pixel: views from the shopper's browser for a completed checkout.
 * Saved by order id, then applied to the order (now if it's recorded, or when the
 * orders/create webhook arrives). Only adds INFLUENCED credit to lines that have none.
 */
export async function recordPixelViews(shopId: string, orderIdRaw: unknown, seen: SeenEntry[]) {
  const orderId = numericId(orderIdRaw);
  if (!orderId || !seen.length) return { skipped: "nothing to record" as const };
  const value = encodeSeen(seen.slice(0, 50));
  await prisma.wallPixelView.upsert({
    where: { shopId_orderId: { shopId, orderId } },
    update: { seen: value },
    create: { shopId, orderId, seen: value },
  });

  const order = await prisma.wallOrder.findUnique({
    where: { shopId_orderId: { shopId, orderId } },
    select: { id: true, orderedAt: true, day: true, currency: true, counted: true, linesJson: true, lines: { select: { lineItemId: true, kind: true } } },
  });
  if (!order) return { saved: true as const, applied: 0 }; // webhook hasn't arrived yet — recordOrder picks it up
  if (Date.now() - order.orderedAt.getTime() > PIXEL_REPORT_WINDOW_MS) return { skipped: "too late" as const };

  let all: OrderLine[] = [];
  try {
    all = JSON.parse(order.linesJson || "[]");
  } catch {}
  const credited = new Set(order.lines.map((l) => l.lineItemId));
  const candidates = all.filter((l) => !credited.has(l.lineItemId) && !l.direct);
  const found = attributeLines(candidates, seen, Math.floor(order.orderedAt.getTime() / 1000));
  const posts = await loadPosts(shopId, found.map((l) => l.submissionId));
  const lines = verifyLines(found, posts);
  if (!lines.length) return { saved: true as const, applied: 0 };

  let applied = 0;
  try {
    await prisma.$transaction(async (tx) => {
      for (const l of lines) {
        await tx.wallOrderLine.create({
          data: {
            orderRefId: order.id,
            lineItemId: l.lineItemId,
            productId: l.productId,
            productTitle: l.productTitle,
            kind: l.kind,
            campaignId: l.campaignId,
            submissionId: l.submissionId,
            quantity: l.quantity,
            revenueCents: l.revenueCents,
          },
        });
      }
      applied = lines.length;
      if (!order.counted) return;
      const d = lineDeltas(lines.map((l) => ({ ...l, cents: l.revenueCents })));
      await bump(tx, shopId, order.day, order.currency, {
        influenced: d.influenced,
        influencedOrders: order.lines.some((l) => l.kind === "INFLUENCED") ? 0 : 1,
      }, d.posts);
    });
  } catch (err: any) {
    if (err?.code === "P2002") return { skipped: "duplicate" as const }; // a concurrent report credited it
    throw err;
  }
  return { saved: true as const, applied };
}

/** refunds/create — subtract refunded amounts once per refund. */
export async function recordRefund(shopDomain: string, payload: unknown) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return { skipped: "unknown shop" as const };
  const refund = parseRefund(payload);
  if (!refund) return { skipped: "bad payload" as const };

  const order = await prisma.wallOrder.findUnique({
    where: { shopId_orderId: { shopId: shop.id, orderId: refund.orderId } },
    select: {
      id: true, day: true, currency: true, counted: true, revenueCents: true, refundedCents: true,
      lines: { select: { id: true, lineItemId: true, kind: true, submissionId: true, campaignId: true, revenueCents: true, refundedCents: true } },
    },
  });
  if (!order) return { skipped: "order not tracked" as const }; // placed before the app was tracking

  try {
    await prisma.$transaction(async (tx) => {
      await tx.wallRefund.create({ data: { shopId: shop.id, refundId: refund.refundId } });
      const newOrderRefunded = Math.min(order.revenueCents, order.refundedCents + refund.totalCents);
      await tx.wallOrder.update({ where: { id: order.id }, data: { refundedCents: newOrderRefunded } });
      const changed: { kind: string; submissionId: string | null; campaignId: string | null; cents: number }[] = [];
      for (const r of refund.lines) {
        const line = order.lines.find((l) => l.lineItemId === r.lineItemId);
        if (!line) continue;
        const next = Math.min(line.revenueCents, line.refundedCents + r.cents);
        if (next === line.refundedCents) continue;
        await tx.wallOrderLine.update({ where: { id: line.id }, data: { refundedCents: next } });
        changed.push({ ...line, cents: -(next - line.refundedCents) });
      }
      if (!order.counted) return;
      const d = lineDeltas(changed);
      // Refunds reduce the day the order was placed, so past days stay comparable
      await bump(tx, shop.id, order.day, order.currency, {
        total: -(newOrderRefunded - order.refundedCents),
        direct: d.direct,
        influenced: d.influenced,
      }, d.posts);
    });
  } catch (err: any) {
    if (err?.code === "P2002") return { skipped: "duplicate" as const };
    throw err;
  }
  return { recorded: true as const };
}

/**
 * Recompute a shop's rollups from its order rows (backfill / repair). Orders without a
 * day get one from `timeZone`. Safe to run any time.
 */
export async function rebuildSalesStats(shopId: string, timeZone: string) {
  const orders = await prisma.wallOrder.findMany({
    where: { shopId },
    select: {
      id: true, orderedAt: true, day: true, currency: true, test: true, revenueCents: true, refundedCents: true,
      lines: { select: { kind: true, submissionId: true, campaignId: true, revenueCents: true, refundedCents: true } },
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.wallDailyStat.deleteMany({ where: { shopId } });
    await tx.wallPostDailyStat.deleteMany({ where: { shopId } });
    for (const o of orders) {
      const day = o.day || dayKey(o.orderedAt, timeZone);
      const counted = COUNT_TEST_ORDERS || !o.test;
      await tx.wallOrder.update({ where: { id: o.id }, data: { day, counted } });
      if (!counted) continue;
      const d = lineDeltas(o.lines.map((l) => ({ ...l, cents: Math.max(0, l.revenueCents - l.refundedCents) })));
      await bump(tx, shopId, day, o.currency, {
        total: Math.max(0, o.revenueCents - o.refundedCents),
        direct: d.direct,
        influenced: d.influenced,
        directOrders: o.lines.some((l) => l.kind === "DIRECT") ? 1 : 0,
        influencedOrders: o.lines.some((l) => l.kind === "INFLUENCED") ? 1 : 0,
      }, d.posts);
    }
  }, { timeout: 120_000 });
  return { orders: orders.length };
}

// ── Reporting ────────────────────────────────────────────────────

export type DayPoint = { date: string; direct: number; influenced: number; total: number };

export type SalesSummary = {
  days: number;
  currency: string;
  totalCents: number;
  directCents: number;
  influencedCents: number;
  directOrders: number;
  influencedOrders: number;
  series: DayPoint[];
  topPosts: {
    submissionId: string;
    campaignId: string | null;
    campaignTitle: string | null;
    thumbnailUrl: string | null;
    displayName: string | null;
    directCents: number;
    influencedCents: number;
  }[];
  topWalls: { campaignId: string; title: string; directCents: number; influencedCents: number }[];
  trackingSince: Date | null;
};

export function dayKey(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const tzCache = new Map<string, { tz: string; at: number }>();

/** The shop's IANA time zone (cached for an hour) — day boundaries follow the merchant's clock. */
export async function shopTimeZone(
  graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response>,
  shopDomain: string,
): Promise<string> {
  const hit = tzCache.get(shopDomain);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.tz;
  try {
    const res = await graphql(`#graphql
      query WallShopTimeZone { shop { ianaTimezone } }`);
    const body: any = await res.json();
    const tz = body?.data?.shop?.ianaTimezone || "UTC";
    tzCache.set(shopDomain, { tz, at: Date.now() });
    return tz;
  } catch {
    return hit?.tz || "UTC";
  }
}

/** Reads only rollup rows: ≤ `days` day rows + the posts that earned in that range. */
export async function getSalesSummary(shopId: string, days: number, timeZone = "UTC"): Promise<SalesSummary> {
  // One point per day, oldest first, including days with no sales
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000), timeZone));
  const from = keys[0];
  const to = keys[keys.length - 1];

  const [dayRows, postGroups, first] = await Promise.all([
    prisma.wallDailyStat.findMany({ where: { shopId, day: { gte: from, lte: to } } }),
    prisma.wallPostDailyStat.groupBy({
      by: ["submissionId", "campaignId"],
      where: { shopId, day: { gte: from, lte: to } },
      _sum: { directCents: true, influencedCents: true },
    }),
    prisma.wallDailyStat.findFirst({ where: { shopId }, orderBy: { day: "asc" }, select: { day: true } }),
  ]);

  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const series: DayPoint[] = keys.map((k) => {
    const r = byDay.get(k);
    return { date: k, direct: r?.directCents || 0, influenced: r?.influencedCents || 0, total: r?.totalCents || 0 };
  });
  const sum = (f: (r: (typeof dayRows)[number]) => number) => dayRows.reduce((s, r) => s + f(r), 0);
  const currencyCount = new Map<string, number>();
  for (const r of dayRows) currencyCount.set(r.currency, (currencyCount.get(r.currency) || 0) + 1);

  const posts = postGroups.map((g) => ({
    submissionId: g.submissionId,
    campaignId: g.campaignId,
    direct: g._sum.directCents || 0,
    influenced: g._sum.influencedCents || 0,
  }));
  const walls = new Map<string, { direct: number; influenced: number }>();
  for (const p of posts) {
    if (!p.campaignId) continue;
    const w = walls.get(p.campaignId) || { direct: 0, influenced: 0 };
    w.direct += p.direct;
    w.influenced += p.influenced;
    walls.set(p.campaignId, w);
  }
  const topPosts = posts.filter((p) => p.direct + p.influenced > 0).sort((a, b) => b.direct + b.influenced - (a.direct + a.influenced)).slice(0, 5);
  const topWallIds = [...walls.entries()]
    .filter(([, w]) => w.direct + w.influenced > 0)
    .sort((a, b) => b[1].direct + b[1].influenced - (a[1].direct + a[1].influenced))
    .slice(0, 5);

  const [postRows, wallRows] = await Promise.all([
    prisma.submission.findMany({
      where: { id: { in: topPosts.map((p) => p.submissionId) } },
      select: { id: true, thumbnailUrl: true, displayName: true, campaign: { select: { title: true } } },
    }),
    prisma.campaign.findMany({
      where: { shopId, id: { in: [...new Set([...topWallIds.map(([id]) => id), ...topPosts.map((p) => p.campaignId || "")])] } },
      select: { id: true, title: true },
    }),
  ]);
  const titleOf = new Map(wallRows.map((w) => [w.id, w.title]));

  return {
    days,
    currency: [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "USD",
    totalCents: sum((r) => r.totalCents),
    directCents: sum((r) => r.directCents),
    influencedCents: sum((r) => r.influencedCents),
    directOrders: sum((r) => r.directOrders),
    influencedOrders: sum((r) => r.influencedOrders),
    series,
    topPosts: topPosts.map((p) => {
      const row = postRows.find((r) => r.id === p.submissionId);
      return {
        submissionId: p.submissionId,
        campaignId: p.campaignId,
        campaignTitle: row?.campaign.title ?? (p.campaignId ? titleOf.get(p.campaignId) ?? null : null),
        thumbnailUrl: row?.thumbnailUrl ?? null,
        displayName: row?.displayName ?? null,
        directCents: p.direct,
        influencedCents: p.influenced,
      };
    }),
    topWalls: topWallIds.map(([id, w]) => ({
      campaignId: id,
      title: titleOf.get(id) || "Deleted wall campaign",
      directCents: w.direct,
      influencedCents: w.influenced,
    })),
    trackingSince: first ? new Date(`${first.day}T12:00:00Z`) : null,
  };
}
