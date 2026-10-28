/**
 * Sales attribution markers (see app/utils/attribution.ts for how orders are read).
 *  - Add to cart from a post → line item property `_social_wall` = "<wall>:<post>"   (DIRECT)
 *  - Watching a post for a few seconds → its linked products are remembered for 7 days
 *    in the cart attribute `_social_wall_seen`                                       (INFLUENCED)
 * Underscore-prefixed keys are hidden from shoppers by Shopify checkout and most themes.
 */
import type { MediaItem } from "./types";

export const LINE_PROPERTY = "_social_wall";
const SEEN_ATTRIBUTE = "_social_wall_seen";
const STORAGE_KEY = "social_wall_seen";
const WINDOW_SECS = 7 * 24 * 60 * 60;
const MAX_ENTRIES = 20;
/** How long a post must be on screen before it counts as "watched" */
export const VIEW_THRESHOLD_MS = 3000;

type Seen = { p: string; s: string; t: number };

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function numericId(v: string): string | null {
  const m = String(v).match(/(\d+)$/);
  return m ? m[1] : null;
}

function routesRoot(): string {
  const root = (window as any).Shopify?.routes?.root;
  return typeof root === "string" && root ? root : "/";
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function load(): Seen[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const cutoff = now() - WINDOW_SECS;
    return raw.filter((e: any) => e && typeof e.p === "string" && typeof e.s === "string" && Number(e.t) > cutoff);
  } catch {
    return [];
  }
}

function save(entries: Seen[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

function encode(entries: Seen[]): string {
  return entries.map((e) => `${e.p}:${e.s}:${e.t}`).join(",");
}

let lastSynced: string | null = null;

/** Copy remembered views onto the cart, so they reach the order. */
async function pushToCart(entries: Seen[]) {
  const value = encode(entries);
  if (value === lastSynced) return;
  try {
    const res = await fetch(`${routesRoot()}cart/update.js`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ attributes: { [SEEN_ATTRIBUTE]: value } }),
    });
    if (res.ok) lastSynced = value;
  } catch {}
}

/** Respect the store's cookie banner: no tracking when the shopper declined analytics. */
function analyticsAllowed(): boolean {
  try {
    const privacy = (window as any).Shopify?.customerPrivacy;
    if (privacy && typeof privacy.analyticsProcessingAllowed === "function") return !!privacy.analyticsProcessingAllowed();
  } catch {}
  return true; // no consent banner on this store/region
}

/** A shopper watched this post → remember its products (most recent view wins). */
export function recordView(item: MediaItem) {
  if (!SAFE_ID.test(item.id) || !analyticsAllowed()) return;
  const productIds = (item.products || []).map((p) => numericId(p.id)).filter((id): id is string => !!id);
  if (!productIds.length) return;
  const t = now();
  const fresh = new Set(productIds);
  const entries = [...productIds.map((p) => ({ p, s: item.id, t })), ...load().filter((e) => !fresh.has(e.p))].slice(0, MAX_ENTRIES);
  save(entries);
  void pushToCart(entries);
}

/**
 * When a wall loads, make sure the current cart carries recent views — a new cart
 * (e.g. after a previous checkout) starts without them.
 */
export async function syncViewsToCart() {
  if (!analyticsAllowed()) return;
  const entries = load();
  if (!entries.length) return;
  try {
    const cart = await fetch(`${routesRoot()}cart.js`, { headers: { Accept: "application/json" } }).then((r) => r.json());
    lastSynced = String(cart?.attributes?.[SEEN_ATTRIBUTE] ?? "") || null;
  } catch {}
  await pushToCart(entries);
}

/** Line item properties for an add-to-cart from this post. */
export function directProperties(item: MediaItem): Record<string, string> | undefined {
  if (!item.wall || !SAFE_ID.test(item.wall) || !SAFE_ID.test(item.id)) return undefined;
  return { [LINE_PROPERTY]: `${item.wall}:${item.id}` };
}
