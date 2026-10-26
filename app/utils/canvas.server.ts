/**
 * Social Wall (UGME Canvas) — server helpers.
 *
 * 1. getCanvasMedia(): the JSON the storefront canvas loads via the app proxy
 *    (/apps/ugme/canvas?campaigns=id1,id2). Only APPROVED submissions with
 *    rights accepted are ever returned. Media is served from R2 via presigned
 *    GET URLs (CORS must be enabled on the bucket — see scripts/r2-cors.ts).
 *
 * 2. syncCampaignMetaobjects(): mirrors the shop's wall campaigns into an
 *    app-owned metaobject type ($app:ugme_campaign, declared in shopify.app.toml)
 *    so the merchant can pick one in the Social Wall block settings. The entry's
 *    `status` field lets the block render nothing unless the wall is ACTIVE.
 */
import prisma from "../db.server";
import { extractKeyFromContentUrl, getCacheableDownloadUrl } from "./r2.server";
import { MAX_POST_PRODUCTS, parseProducts } from "./wall-campaigns.server";
import { PROXY_BASE } from "./proxy-path";

export const CANVAS_METAOBJECT_TYPE = "$app:ugme_campaign";
const MAX_ITEMS = 300;

export type CanvasProduct = { id: string; title: string; handle: string | null; imageUrl: string | null };

export type CanvasItem = {
  id: string;
  type: "image" | "video";
  src: string;
  thumb: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  /** "Sam K." when the customer opted in to showing their name */
  author: string | null;
  /** Every post comes from a verified buyer */
  verified: true;
  /** Products this buyer purchased (product cards in the viewer) */
  products: CanvasProduct[];
};

export type CanvasWall = {
  id: string;
  title: string;
  active: boolean;
  /** Customer submit page for the "Share yours" button */
  shareUrl: string;
  /** Spots left under the wall's submission limit (null = no limit). 0 → hide "Share yours". */
  spotsLeft: number | null;
};

async function resolveUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  if (url === "r2://pending" || url.includes("placeholder.ugme.app")) return null;
  const key = extractKeyFromContentUrl(url);
  // Stable-per-window URLs → browsers/CDN cache thumbnails & videos across page views
  if (key) return getCacheableDownloadUrl(key);
  return url.startsWith("http") ? url : null;
}

export async function getCanvasMedia(
  shopId: string,
  campaignIds: string[],
  opts: { productId?: string | null } = {},
): Promise<CanvasItem[]> {
  const ids = campaignIds.map((s) => s.trim()).filter(Boolean).slice(0, 50);

  const submissions = await prisma.submission.findMany({
    where: {
      status: "APPROVED",
      rightsAccepted: true,
      campaign: ids.length
        ? { shopId, id: { in: ids }, status: "ACTIVE" }
        : { shopId, status: "ACTIVE" },
      // "This product only" (product pages): posts linked to that product
      ...(opts.productId ? { products: { contains: `"${opts.productId}"` } } : {}),
    },
    select: {
      id: true,
      contentType: true,
      contentUrl: true,
      thumbnailUrl: true,
      displayName: true,
      products: true,
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ITEMS,
  });

  const items = await Promise.all(
    submissions.map(async (s): Promise<CanvasItem | null> => {
      const src = await resolveUrl(s.contentUrl);
      if (!src) return null;
      const thumb = await resolveUrl(s.thumbnailUrl);
      const products = parseProducts(s.products).slice(0, MAX_POST_PRODUCTS);
      return {
        id: s.id,
        type: s.contentType === "VIDEO" ? "video" : "image",
        src,
        thumb,
        width: null,
        height: null,
        caption: s.displayName ? `${s.displayName} · Verified buyer` : "Verified buyer",
        author: s.displayName || null,
        verified: true,
        products,
      };
    }),
  );

  return items.filter((i): i is CanvasItem => i !== null);
}

/** Normalise a product reference from the theme ("123" or a GID) to a GID. */
function productGid(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(t)) return t;
  if (/^\d+$/.test(t)) return `gid://shopify/Product/${t}`;
  return null;
}

export async function canvasJsonResponse(shopId: string, url: URL): Promise<Response> {
  // New: one wall campaign per block (?wall=<id>). Legacy: ?campaigns=a,b
  const wallId = (url.searchParams.get("wall") || "").trim();
  const campaigns = wallId ? [wallId] : (url.searchParams.get("campaigns") || "").split(",");
  const productId = productGid(url.searchParams.get("product"));
  try {
    let wall: CanvasWall | null = null;
    if (wallId) {
      const c = await prisma.campaign.findFirst({ where: { id: wallId, shopId }, select: { id: true, title: true, status: true, maxSubmissions: true } });
      if (c) {
        const used = c.maxSubmissions == null ? 0 : await prisma.submission.count({ where: { campaignId: c.id, status: { not: "REJECTED" } } });
        wall = {
          id: c.id,
          title: c.title,
          active: c.status === "ACTIVE",
          shareUrl: `${PROXY_BASE}/campaign/${c.id}/submit`,
          spotsLeft: c.maxSubmissions == null ? null : Math.max(0, c.maxSubmissions - used),
        };
      }
    }
    const items = wallId && !wall?.active ? [] : await getCanvasMedia(shopId, campaigns, { productId });
    return new Response(JSON.stringify({ wall, items }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // short cache: URLs are valid for 6h+, approvals show up within 5 min
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("[canvas] failed to load media", err);
    return new Response(JSON.stringify({ items: [], error: "failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

// ── Campaign → metaobject sync ──────────────────────────────────

type AdminGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

const SYNC_BATCH = 20;
const lastSync = new Map<string, { at: number; signature: string }>();
const MIN_INTERVAL_MS = 30_000;
const MAX_STALE_MS = 10 * 60_000;

/**
 * The definition normally comes from shopify.app.toml, but Shopify doesn't
 * always provision it (e.g. after an uninstall/reinstall on a dev store).
 * Create it ourselves if it's missing, so the theme block's picker never ends
 * up empty. Fields/access mirror the TOML.
 */
export async function ensureWallMetaobjectDefinition(graphql: AdminGraphql): Promise<string | null> {
  const res = await graphql(
    `#graphql
    query WallDefinition($type: String!) { metaobjectDefinitionByType(type: $type) { id } }`,
    { variables: { type: CANVAS_METAOBJECT_TYPE } },
  );
  const body: any = await res.json().catch(() => ({}));
  if (body?.data?.metaobjectDefinitionByType?.id) return null;
  const create = await graphql(
    `#graphql
    mutation WallDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id } userErrors { field message code } }
    }`,
    {
      variables: {
        definition: {
          type: CANVAS_METAOBJECT_TYPE,
          name: "Wall campaign",
          description: "A Social Wall campaign, selectable in the Social Wall theme block",
          displayNameKey: "title",
          access: { admin: "MERCHANT_READ", storefront: "PUBLIC_READ" },
          fieldDefinitions: [
            { key: "title", name: "Title", type: "single_line_text_field", required: true },
            { key: "campaign_id", name: "Campaign ID", type: "single_line_text_field", required: true },
            { key: "status", name: "Status", type: "single_line_text_field" },
          ],
        },
      },
    },
  );
  const cb: any = await create.json().catch(() => ({}));
  const errs = [...(cb?.errors ?? []), ...(cb?.data?.metaobjectDefinitionCreate?.userErrors ?? [])].map((e: any) => e.message);
  if (errs.length) {
    console.warn("[canvas] couldn't create the wall campaign definition", errs);
    return errs.join("; ");
  }
  console.log("[canvas] created missing wall campaign metaobject definition");
  return null;
}

export async function syncCampaignMetaobjects(graphql: AdminGraphql, shopDomain: string) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return { synced: 0, errors: [] as string[] };

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id, rewardType: { not: "SUBSCRIPTION_DISCOUNT" } },
    select: { id: true, title: true, status: true },
    orderBy: { createdAt: "desc" },
  });

  const errors: string[] = [];
  const defError = await ensureWallMetaobjectDefinition(graphql).catch((e) => String(e));
  if (defError) errors.push(defError);
  for (let i = 0; i < campaigns.length; i += SYNC_BATCH) {
    const batch = campaigns.slice(i, i + SYNC_BATCH);
    const varDefs = batch.map((_, n) => `$h${n}: MetaobjectHandleInput!, $m${n}: MetaobjectUpsertInput!`).join(", ");
    const body = batch
      .map(
        (_, n) =>
          `c${n}: metaobjectUpsert(handle: $h${n}, metaobject: $m${n}) { metaobject { id } userErrors { field message } }`,
      )
      .join("\n");
    const variables: Record<string, unknown> = {};
    batch.forEach((c, n) => {
      variables[`h${n}`] = { type: CANVAS_METAOBJECT_TYPE, handle: `wall-${c.id}`.toLowerCase() };
      variables[`m${n}`] = {
        fields: [
          { key: "title", value: c.title },
          { key: "campaign_id", value: c.id },
          { key: "status", value: c.status },
        ],
      };
    });

    const res = await graphql(`mutation UgmeSyncCampaigns(${varDefs}) {\n${body}\n}`, { variables });
    const json = (await res.json()) as {
      data?: Record<string, { userErrors: { message: string }[] }>;
      errors?: { message: string }[];
    };
    if (json.errors?.length) errors.push(...json.errors.map((e) => e.message));
    for (const r of Object.values(json.data ?? {})) {
      if (r?.userErrors?.length) errors.push(...r.userErrors.map((e) => e.message));
    }
  }

  if (errors.length) console.warn("[canvas] metaobject sync errors", errors);
  if (errors.length) lastSync.delete(shopDomain);
  else lastSync.set(shopDomain, { at: Date.now(), signature: signatureOf(campaigns) });
  return { synced: campaigns.length, errors };
}

function signatureOf(campaigns: { id: string; title: string; status: string }[]) {
  return campaigns.map((c) => `${c.id}:${c.status}:${c.title}`).join("|");
}

/**
 * Cheap, throttled sync for the admin layout loader. Fire-and-forget: never
 * blocks or breaks page loads. Re-syncs when campaigns changed or every 10 min.
 */
export function maybeSyncCampaignMetaobjects(graphql: AdminGraphql, shopDomain: string) {
  const prev = lastSync.get(shopDomain);
  const now = Date.now();
  if (prev && now - prev.at < MIN_INTERVAL_MS) return;

  (async () => {
    if (prev && now - prev.at < MAX_STALE_MS) {
      const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
      if (!shop) return;
      const campaigns = await prisma.campaign.findMany({
        where: { shopId: shop.id, rewardType: { not: "SUBSCRIPTION_DISCOUNT" } },
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "desc" },
      });
      if (signatureOf(campaigns) === prev.signature) return;
    }
    await syncCampaignMetaobjects(graphql, shopDomain);
  })().catch((err) => console.warn("[canvas] background sync failed", err));
}

/** Sync right away (after create / activate / pause / rename) — bypasses the throttle. */
export async function syncWallCampaignsNow(graphql: AdminGraphql, shopDomain: string) {
  try {
    return await syncCampaignMetaobjects(graphql, shopDomain);
  } catch (err) {
    console.warn("[canvas] immediate sync failed", err);
    return { synced: 0, errors: [String(err)] };
  }
}
