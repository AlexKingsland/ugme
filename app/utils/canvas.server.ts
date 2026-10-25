/**
 * Social Wall (UGME Canvas) — server helpers.
 *
 * 1. getCanvasMedia(): the JSON the storefront canvas loads via the app proxy
 *    (/apps/ugme/canvas?campaigns=id1,id2). Only APPROVED submissions with
 *    rights accepted are ever returned. Media is served from R2 via presigned
 *    GET URLs (CORS must be enabled on the bucket — see scripts/r2-cors.ts).
 *
 * 2. syncCampaignMetaobjects(): mirrors the shop's campaigns into an app-owned
 *    metaobject type ($app:ugme_campaign, declared in shopify.app.toml) so the
 *    merchant can pick campaigns from a list in the theme editor block settings.
 */
import prisma from "../db.server";
import { extractKeyFromContentUrl, getCacheableDownloadUrl } from "./r2.server";

export const CANVAS_METAOBJECT_TYPE = "$app:ugme_campaign";
const MAX_ITEMS = 300;

export type CanvasItem = {
  id: string;
  type: "image" | "video";
  src: string;
  thumb: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
};

async function resolveUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  if (url === "r2://pending" || url.includes("placeholder.ugme.app")) return null;
  const key = extractKeyFromContentUrl(url);
  // Stable-per-window URLs → browsers/CDN cache thumbnails & videos across page views
  if (key) return getCacheableDownloadUrl(key);
  return url.startsWith("http") ? url : null;
}

export async function getCanvasMedia(shopId: string, campaignIds: string[]): Promise<CanvasItem[]> {
  const ids = campaignIds.map((s) => s.trim()).filter(Boolean).slice(0, 50);

  const submissions = await prisma.submission.findMany({
    where: {
      status: "APPROVED",
      rightsAccepted: true,
      campaign: ids.length
        ? { shopId, id: { in: ids } }
        : { shopId, status: "ACTIVE" },
    },
    select: {
      id: true,
      contentType: true,
      contentUrl: true,
      thumbnailUrl: true,
      campaign: { select: { productTitle: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ITEMS,
  });

  const items = await Promise.all(
    submissions.map(async (s): Promise<CanvasItem | null> => {
      const src = await resolveUrl(s.contentUrl);
      if (!src) return null;
      const thumb = await resolveUrl(s.thumbnailUrl);
      const product = s.campaign.productTitle;
      return {
        id: s.id,
        type: s.contentType === "VIDEO" ? "video" : "image",
        src,
        thumb,
        width: null,
        height: null,
        caption: product ? `Shot by a real customer · ${product}` : "Shot by a real customer",
      };
    }),
  );

  return items.filter((i): i is CanvasItem => i !== null);
}

export async function canvasJsonResponse(shopId: string, url: URL): Promise<Response> {
  const campaigns = (url.searchParams.get("campaigns") || "").split(",");
  try {
    const items = await getCanvasMedia(shopId, campaigns);
    return new Response(JSON.stringify({ items }), {
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

export async function syncCampaignMetaobjects(graphql: AdminGraphql, shopDomain: string) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return { synced: 0, errors: [] as string[] };

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id, status: { not: "DRAFT" } },
    select: { id: true, title: true, status: true },
    orderBy: { createdAt: "desc" },
  });

  const errors: string[] = [];
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
      variables[`h${n}`] = { type: CANVAS_METAOBJECT_TYPE, handle: `campaign-${c.id}`.toLowerCase() };
      variables[`m${n}`] = {
        fields: [
          { key: "title", value: c.status === "ACTIVE" ? c.title : `${c.title} (${c.status.toLowerCase()})` },
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
  lastSync.set(shopDomain, { at: Date.now(), signature: signatureOf(campaigns) });
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
        where: { shopId: shop.id, status: { not: "DRAFT" } },
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "desc" },
      });
      if (signatureOf(campaigns) === prev.signature) return;
    }
    await syncCampaignMetaobjects(graphql, shopDomain);
  })().catch((err) => console.warn("[canvas] background sync failed", err));
}
