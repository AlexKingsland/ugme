/**
 * Social Wall checkout pixel (sales attribution for "Buy it now" checkouts).
 *
 * The pixel does nothing until the app activates it with webPixelCreate. The app does
 * that ONCE per store. Merchants can disconnect it under Settings → Customer events;
 * after that the app never turns it back on by itself — the Analytics page shows that
 * tracking is off and offers a button to turn it on again.
 */
import prisma from "../db.server";
import { PROXY_BASE } from "./proxy-path";

type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

export type PixelStatus = "on" | "off" | "unknown";

const SETTINGS = JSON.stringify({ proxyPath: PROXY_BASE });

/** Is the pixel connected on this store right now? */
export async function pixelStatus(graphql: Graphql): Promise<PixelStatus> {
  try {
    const res = await graphql(`#graphql
      query SocialWallPixel { webPixel { id } }`);
    const body: any = await res.json();
    if (body?.data?.webPixel?.id) return "on";
    // Shopify answers "no web pixel" with a not-found error rather than null
    const notFound = (body?.errors || []).some((e: any) => /not.?found|no web pixel/i.test(String(e?.message || "")));
    return notFound || body?.data?.webPixel === null ? "off" : "unknown";
  } catch (err: any) {
    // the admin client throws on GraphQL errors
    const msg = JSON.stringify(err?.body?.errors || err?.message || "");
    return /not.?found|no web pixel/i.test(msg) ? "off" : "unknown";
  }
}

/** Create (or re-create, when the merchant asks) the pixel. */
export async function activatePixel(graphql: Graphql, shopDomain: string): Promise<boolean> {
  try {
    const res = await graphql(`#graphql
      mutation SocialWallPixelCreate($settings: JSON!) {
        webPixelCreate(webPixel: { settings: $settings }) {
          webPixel { id }
          userErrors { code field message }
        }
      }`, { variables: { settings: SETTINGS } });
    const body: any = await res.json();
    const out = body?.data?.webPixelCreate;
    const taken = (out?.userErrors || []).some((e: any) => e?.code === "TAKEN" || /already/i.test(String(e?.message || "")));
    if (!out?.webPixel?.id && !taken) {
      console.warn(`[pixel] couldn't activate for ${shopDomain}:`, JSON.stringify(out?.userErrors || body?.errors));
      return false;
    }
    await prisma.shop.update({ where: { shopDomain }, data: { pixelActivatedAt: new Date() } });
    return true;
  } catch (err) {
    console.warn(`[pixel] couldn't activate for ${shopDomain}:`, err);
    return false;
  }
}

/**
 * First-time setup only: turn the pixel on if this app never has for this store.
 * Records the activation if the pixel is already there (e.g. older installs).
 */
export async function ensurePixelOnce(graphql: Graphql, shopDomain: string): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { pixelActivatedAt: true } });
  if (!shop || shop.pixelActivatedAt) return; // done before — respect whatever the merchant chose since
  const status = await pixelStatus(graphql);
  if (status === "on") {
    await prisma.shop.update({ where: { shopDomain }, data: { pixelActivatedAt: new Date() } });
    return;
  }
  if (status === "off") await activatePixel(graphql, shopDomain);
}

const tried = new Map<string, number>();

/** Fire-and-forget from the admin layout; at most every 10 minutes per store per process. */
export function maybeEnsurePixelOnce(graphql: Graphql, shopDomain: string) {
  const last = tried.get(shopDomain) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  tried.set(shopDomain, Date.now());
  ensurePixelOnce(graphql, shopDomain).catch((err) => console.warn("[pixel] setup failed:", err));
}
