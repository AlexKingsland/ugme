/**
 * Brand posts: the merchant's own photos and videos, added straight to a wall to fill
 * it while it's new. They go live immediately (no review, no reward), show a
 * "From the brand" label instead of "Verified buyer", and count toward the plan's
 * approvals and storage like any other post. They don't use up customer spots.
 */
import crypto from "crypto";
import prisma from "../db.server";
import { buildObjectKey, getPresignedUploadUrl, headObject, posterKeyFor, deleteObject } from "./r2.server";
import { checkPlanGates, checkSubmissionLimit, type PlanTierKey } from "./plans.server";
import { fileTypeAllowed, parseProducts, submissionTypeFor, type WallProduct } from "./wall-campaigns";
import { onSubmissionApproved } from "./public-media.server";

export const BRAND_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB, same as customers
const CAPTION_MAX = 300;
const TTL_SECS = 6 * 60 * 60;

type ShopRow = { id: string; shopDomain: string; planTier: string | null };

function sign(parts: string[]) {
  const secret = process.env.SHOPIFY_API_SECRET || "ugme-dev-upload-secret";
  return crypto.createHmac("sha256", secret).update(["brand", ...parts].join("|")).digest("hex");
}

/** The store itself, as the "customer" its brand posts belong to (one per shop). */
export async function brandCustomer(shop: { id: string; shopDomain: string }) {
  const email = `brand@${shop.shopDomain}`;
  return prisma.customer.upsert({
    where: { shopId_email: { shopId: shop.id, email } },
    update: {},
    create: { shopId: shop.id, email },
  });
}

export type BrandUploadError = "too_large" | "wrong_type" | "storage" | "approvals" | "not_found" | "upload_failed" | "expired";

export async function createBrandUpload(
  shop: ShopRow,
  campaignId: string,
  file: { name: string; type: string; size: number },
): Promise<{ ok: true; key: string; uploadUrl: string; posterUploadUrl: string; expires: number; token: string } | { ok: false; error: BrandUploadError }> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId: shop.id }, select: { id: true, title: true, contentType: true } });
  if (!campaign) return { ok: false, error: "not_found" };
  if (!file.size || file.size > BRAND_MAX_BYTES) return { ok: false, error: "too_large" };
  if (!fileTypeAllowed(campaign.contentType, file.type)) return { ok: false, error: "wrong_type" };
  const tier = (shop.planTier as PlanTierKey) || "FREE";
  const [gates, approvals] = await Promise.all([checkPlanGates(shop.id, tier, file.size), checkSubmissionLimit(shop.id, tier)]);
  if (!gates.canAcceptSubmission) return { ok: false, error: "storage" };
  if (!approvals.ok) return { ok: false, error: "approvals" };

  const key = buildObjectKey(shop.shopDomain, campaign.title, `brand-${crypto.randomUUID()}`, file.name.slice(0, 200));
  const expires = Date.now() + TTL_SECS * 1000;
  const [uploadUrl, posterUploadUrl] = await Promise.all([
    getPresignedUploadUrl(key, file.type || "application/octet-stream", TTL_SECS),
    getPresignedUploadUrl(posterKeyFor(key), "image/jpeg", TTL_SECS),
  ]);
  return { ok: true, key, uploadUrl, posterUploadUrl, expires, token: sign([shop.id, campaign.id, key, String(expires)]) };
}

export async function completeBrandUpload(
  shop: ShopRow,
  campaignId: string,
  body: { key: string; expires: number; token: string; caption?: string; productIds?: string[]; hasPoster?: boolean; durationSecs?: number },
): Promise<{ ok: true; submissionId: string } | { ok: false; error: BrandUploadError }> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId: shop.id }, select: { id: true, contentType: true, products: true } });
  if (!campaign) return { ok: false, error: "not_found" };
  const expected = sign([shop.id, campaign.id, body.key, String(body.expires)]);
  if (body.token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(body.token), Buffer.from(expected)) || !body.key.startsWith(`${shop.shopDomain}/`)) {
    return { ok: false, error: "upload_failed" };
  }
  if (Date.now() > body.expires) return { ok: false, error: "expired" };

  const head = await headObject(body.key).catch(() => null);
  if (!head || head.size === 0) return { ok: false, error: "upload_failed" };
  if (head.size > BRAND_MAX_BYTES) {
    await deleteObject(body.key).catch(() => {});
    return { ok: false, error: "too_large" };
  }
  // Re-check the approval limit now that the file is here (another post may have used the last slot)
  const approvals = await checkSubmissionLimit(shop.id, (shop.planTier as PlanTierKey) || "FREE");
  if (!approvals.ok) {
    await deleteObject(body.key).catch(() => {});
    return { ok: false, error: "approvals" };
  }

  let thumbnailUrl: string | null = null;
  if (body.hasPoster) {
    const poster = await headObject(posterKeyFor(body.key)).catch(() => null);
    if (poster && poster.size > 0 && poster.size < 5 * 1024 * 1024) thumbnailUrl = `r2://${posterKeyFor(body.key)}`;
  }

  // Only the wall's own products can be linked
  const wallProducts = parseProducts(campaign.products);
  const wanted = new Set(body.productIds || []);
  const products: WallProduct[] = wallProducts.filter((p) => wanted.has(p.id));

  const customer = await brandCustomer(shop);
  const now = new Date();
  const sub = await prisma.submission.create({
    data: {
      campaignId: campaign.id,
      customerId: customer.id,
      status: "APPROVED",
      reviewedAt: now,
      fromBrand: true,
      contentType: submissionTypeFor(campaign.contentType, head.contentType),
      contentUrl: `r2://${body.key}`,
      thumbnailUrl,
      durationSecs: Number(body.durationSecs) > 0 ? Math.round(Number(body.durationSecs)) : null,
      fileBytes: head.size,
      description: String(body.caption || "").trim().slice(0, CAPTION_MAX) || null,
      products: JSON.stringify(products),
      rightsAccepted: true,
      usageTags: JSON.stringify(["Social + Product Pages"]),
    },
  });
  // Copy to the public CDN folder + refresh the wall's list (never throws)
  await onSubmissionApproved(sub.id);
  return { ok: true, submissionId: sub.id };
}
