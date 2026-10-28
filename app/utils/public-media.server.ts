/**
 * Public, cacheable copies of APPROVED media (option B: one bucket, public/ prefix).
 *
 * The bucket stays private. A Cloudflare custom domain (MEDIA_PUBLIC_BASE_URL,
 * e.g. https://media.cloverkitstudio.com) serves it, with a WAF rule that
 * blocks every path outside /public/ — so only what we copy here is reachable.
 *
 *   public/<original key>          approved video/photo (cached for a year)
 *   public/<poster key>            its thumbnail
 *   public/walls/<campaignId>.json the wall's post list (cached ~60s)
 *
 * When MEDIA_PUBLIC_BASE_URL isn't set, every function here is a no-op and the
 * app keeps using signed URLs + the app proxy, exactly as before.
 */
import prisma from "../db.server";
import { copyObject, deleteObject, extractKeyFromContentUrl, headObject, posterKeyFor, uploadToR2 } from "./r2.server";

const IMMUTABLE = "public, max-age=31536000, immutable";
const WALL_JSON_CACHE = "public, max-age=60";

export function publicMediaBase(): string | null {
  const v = (process.env.MEDIA_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/]+$/.test(v) ? v : null;
}

export const publicKeyFor = (key: string) => `public/${key}`;
export const wallJsonKey = (campaignId: string) => `public/walls/${campaignId}.json`;

export function publicUrlForKey(key: string): string | null {
  const base = publicMediaBase();
  if (!base) return null;
  return `${base}/${publicKeyFor(key).split("/").map(encodeURIComponent).join("/")}`;
}

export function wallJsonUrl(campaignId: string): string | null {
  const base = publicMediaBase();
  return base ? `${base}/${wallJsonKey(campaignId)}` : null;
}

type MediaRow = { contentUrl: string; thumbnailUrl: string | null };

function keysOf(s: MediaRow): string[] {
  const keys: string[] = [];
  const content = extractKeyFromContentUrl(s.contentUrl);
  if (content && content !== "pending") keys.push(content);
  const thumb = s.thumbnailUrl ? extractKeyFromContentUrl(s.thumbnailUrl) : null;
  if (thumb) keys.push(thumb);
  return keys;
}

/** Copy an approved submission's media into public/. Safe to repeat. */
export async function publishSubmissionMedia(s: MediaRow): Promise<void> {
  if (!publicMediaBase()) return;
  for (const key of keysOf(s)) {
    const head = await headObject(key).catch(() => null);
    if (!head) continue;
    await copyObject(key, publicKeyFor(key), { contentType: head.contentType || undefined, cacheControl: IMMUTABLE });
  }
}

/** Remove a submission's public copies (rejected, deleted, un-approved). */
export async function unpublishSubmissionMedia(s: MediaRow): Promise<void> {
  if (!publicMediaBase()) return;
  for (const key of keysOf(s)) {
    await deleteObject(publicKeyFor(key)).catch(() => {});
    // posters are derived from the content key; make sure that copy goes too
    const poster = posterKeyFor(key);
    if (poster !== key) await deleteObject(publicKeyFor(poster)).catch(() => {});
  }
}

/** Rewrite public/walls/<id>.json from the database. */
export async function rebuildWallJson(campaignId: string): Promise<void> {
  if (!publicMediaBase()) return;
  const { buildWallPayload } = await import("./canvas.server");
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { shopId: true } });
  if (!c) {
    await deleteObject(wallJsonKey(campaignId)).catch(() => {});
    return;
  }
  const payload = await buildWallPayload(c.shopId, campaignId);
  await uploadToR2(wallJsonKey(campaignId), JSON.stringify(payload), "application/json; charset=utf-8", WALL_JSON_CACHE);
}

/** Fire-and-forget-safe refresh after anything that changes what a wall shows. Never throws. */
export async function refreshWall(campaignId: string | null | undefined): Promise<void> {
  if (!campaignId || !publicMediaBase()) return;
  try {
    await rebuildWallJson(campaignId);
  } catch (err) {
    console.warn("[public-media] wall refresh failed", campaignId, err);
  }
}

/** Approved → publish media + refresh the wall. Never throws. */
export async function onSubmissionApproved(submissionId: string): Promise<void> {
  if (!publicMediaBase()) return;
  try {
    const s = await prisma.submission.findUnique({ where: { id: submissionId }, select: { contentUrl: true, thumbnailUrl: true, campaignId: true } });
    if (!s) return;
    await publishSubmissionMedia(s);
    await refreshWall(s.campaignId);
  } catch (err) {
    console.warn("[public-media] publish failed", submissionId, err);
  }
}

/** Rejected / deleted → remove public copies + refresh the wall. Never throws. */
export async function onSubmissionRemoved(s: MediaRow & { campaignId: string }): Promise<void> {
  if (!publicMediaBase()) return;
  try {
    await unpublishSubmissionMedia(s);
  } catch (err) {
    console.warn("[public-media] unpublish failed", err);
  }
  await refreshWall(s.campaignId);
}
