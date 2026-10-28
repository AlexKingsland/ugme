import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { PROXY_BASE } from "../utils/proxy-path";
import { USAGE_RIGHTS_INTRO, usageRightsClauses } from "../utils/usage-rights";
import prisma from "../db.server";
import { verifyProxySignature } from "../utils/proxy-auth.server";
import { proxyLayout } from "../utils/proxy-layout.server";
import crypto from "crypto";
import { buildObjectKey, uploadToR2, deleteObject, extractKeyFromContentUrl, getPresignedDownloadUrl, getPresignedUploadUrl, headObject, posterKeyFor, createMultipartUpload, getPresignedPartUrl, completeMultipartUpload, abortMultipartUpload } from "../utils/r2.server";
import { unauthenticated } from "../shopify.server";
import { liveOnlineStoreProducts } from "../utils/product-availability.server";
import { parseProducts, verifyBuyer, wallRewardOffer, hasReward, type BuyerCheck, type ProductScope } from "../utils/wall-campaigns.server";
import { checkPlanGates, type PlanTierKey } from "../utils/plans.server";
import { canvasJsonResponse } from "../utils/canvas.server";

/**
 * App Proxy catch-all route.
 * Shopify forwards requests from {store}/apps/social-wall/* to this handler.
 *
 * Routes:
 *   /apps/social-wall                          → campaign library (C2.5)
 *   /apps/social-wall/campaign/:id             → campaign detail (C3)
 *   /apps/social-wall/campaign/:id/submit      → upload & submit (C9) — requires auth
 *   /apps/social-wall/campaign/:id/submitted   → confirmation (C10) — requires auth
 *   POST /apps/social-wall/campaign/:id/upload-url → presigned R2 PUT for direct browser upload (JSON)
 *   POST /apps/social-wall/campaign/:id/complete   → confirm upload landed + create submission (JSON)
 *   /apps/social-wall/account                  → my submissions (C11) — requires auth
 *   /apps/social-wall/canvas?campaigns=a,b     → JSON media for the Social Wall theme block
 */

type ShopInfo = {
  id: string;
  shopDomain: string;
  brandName: string | null;
  logoUrl: string | null;
  accessToken: string;
  subscriptionProvider: string;
  providerApiKey: string | null;
  providerConnected: boolean;
  planTier: string;
};

// ── Helpers ─────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rewardText(campaign: Parameters<typeof wallRewardOffer>[0]): string {
  return wallRewardOffer(campaign);
}

/** Verified-buyer check for a wall campaign (uses the shop's offline Admin API session). */
async function checkWallBuyer(
  shop: ShopInfo,
  campaign: { productScope: string; products: string },
  shopifyCustomerId: string,
): Promise<BuyerCheck> {
  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    return await verifyBuyer(admin, shopifyCustomerId, campaign.productScope as ProductScope, parseProducts(campaign.products));
  } catch (err) {
    console.error("[wall] buyer check unavailable:", err);
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Spots left on a wall campaign with a submission limit (rejected submissions free a spot); null = no limit. */
async function spotsLeft(campaign: { id: string; maxSubmissions: number | null }): Promise<number | null> {
  if (campaign.maxSubmissions == null) return null;
  const used = await prisma.submission.count({ where: { campaignId: campaign.id, status: { not: "REJECTED" } } });
  return Math.max(0, campaign.maxSubmissions - used);
}

function spotsText(n: number) {
  return n === 1 ? "1 spot left" : `${n} spots left`;
}

/** "12 of 50 spots filled" with a progress bar (amber when 5 or fewer are left). */
function spotsBarHtml(filled: number, total: number): string {
  const left = Math.max(0, total - filled);
  const pct = Math.min(100, Math.round((filled / total) * 100));
  const low = left <= 5;
  const color = low ? "#d97706" : "var(--ugme-accent)";
  return `
    <div style="margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; margin-bottom: 6px;">
        <span style="font-weight: 600;">${filled} of ${total} spots filled</span>
        <span style="color: ${low ? "#b45309" : "var(--ugme-muted)"}; font-weight: ${low ? 600 : 400};">${spotsText(left)}</span>
      </div>
      <div style="height: 6px; border-radius: 999px; background: var(--ugme-border); overflow: hidden;" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${filled}" aria-label="Spots filled">
        <div style="height: 100%; width: ${pct}%; background: ${color}; border-radius: 999px;"></div>
      </div>
    </div>`;
}

function productNames(campaign: { productScope: string; products: string }): string {
  if (campaign.productScope === "ALL") return "our products";
  const names = parseProducts(campaign.products).map((p) => p.title).filter(Boolean);
  if (!names.length) return "this product";
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
}

/** Which of these products can shoppers actually open on the storefront (active + published)? */
async function liveProductIds(shop: ShopInfo, ids: string[]): Promise<Set<string> | null> {
  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    return await liveOnlineStoreProducts(admin.graphql, ids);
  } catch {
    return null; // unknown → keep the links
  }
}

/** "Shop" links for the wall's products — one button, or a small product list when there are several. */
async function shopLinksHtml(shop: ShopInfo, campaign: { productScope: string; products: string }): Promise<string> {
  const base = `https://${shop.shopDomain}`;
  let products = campaign.productScope === "ALL" ? [] : parseProducts(campaign.products).filter((p) => p.handle);
  // Unpublished products 404 on the storefront — don't link to them
  const live = await liveProductIds(shop, products.map((p) => p.id));
  if (live) products = products.filter((p) => live.has(p.id));
  if (!products.length) {
    return `<a href="${base}/${campaign.productScope === "ALL" ? "collections/all" : ""}" class="ugme-btn ugme-btn--primary" style="display: inline-block; width: auto;">Shop now</a>`;
  }
  if (products.length === 1) {
    const p = products[0];
    return `<a href="${base}/products/${encodeURIComponent(p.handle!)}" class="ugme-btn ugme-btn--primary" style="display: inline-block; width: auto;">Shop ${escapeHtml(p.title)}</a>`;
  }
  return `<div style="display: flex; flex-direction: column; gap: 10px; text-align: left; max-width: 420px; margin: 0 auto;">
    ${products
      .slice(0, 6)
      .map(
        (p) => `<a href="${base}/products/${encodeURIComponent(p.handle!)}" style="display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--ugme-border); border-radius: var(--ugme-radius); text-decoration: none; color: inherit;">
        ${p.imageUrl
          ? `<img src="${escapeHtml(p.imageUrl)}" alt="" style="width: 48px; height: 48px; flex: 0 0 48px; border-radius: 8px; object-fit: cover; background: #f3f3f3;" />`
          : `<span style="width: 48px; height: 48px; flex: 0 0 48px; border-radius: 8px; background: var(--ugme-surface);"></span>`}
        <span style="flex: 1; min-width: 0; font-weight: 600; font-size: 14px; line-height: 1.35;">${escapeHtml(p.title)}</span>
        <span style="font-size: 13px; font-weight: 600; color: var(--ugme-muted); white-space: nowrap;">Shop →</span>
      </a>`,
      )
      .join("")}
  </div>`;
}

async function buyerGatePage(
  check: Exclude<BuyerCheck, { status: "eligible" }>,
  shop: ShopInfo,
  brandName: string,
  campaign: { productScope: string; products: string },
): Promise<Response> {
  const notBuyer = check.status === "not_buyer";
  const shopLinks = notBuyer ? await shopLinksHtml(shop, campaign) : "";
  const body = notBuyer
    ? `
      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">🛍️</div>
        <h1 style="font-size: 20px; margin-bottom: 8px;">This wall is for customers</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px; line-height: 1.6;">Only verified buyers of <strong>${escapeHtml(productNames(campaign))}</strong> can share to this wall. Once you've ordered, come back and share your video.</p>
        ${shopLinks}
      </div>`
    : `
      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">⏳</div>
        <h1 style="font-size: 20px; margin-bottom: 8px;">We couldn't check your order</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px; line-height: 1.6;">Something went wrong while confirming your purchase. Please try again in a moment.</p>
        <a href="" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Try again</a>
      </div>`;
  const html = proxyLayout({ title: notBuyer ? "Customers only" : "Try again", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { status: notBuyer ? 403 : 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * Show a login prompt page that redirects to Shopify's customer login.
 *
 * Shopify has two account types:
 *   - Classic: /account/login?return_url=...
 *   - New (extensible): /account?return_url=... (redirects via email code)
 *
 * For the new accounts, Shopify often ignores return_url for app proxy
 * paths entirely. So instead of relying on Shopify's redirect, we store
 * the intended destination and show a "Continue to UG-ME" button after
 * login. We redirect to the storefront /account page for login, and
 * include both classic and new URL formats.
 */
function loginRedirect(shopDomain: string, returnPath: string): Response {
  const loginUrl = "https://" + shopDomain + "/account/login";
  // Shopify strips <script> from proxy responses and store redirects strip
  // URL params/hashes, so we can't pass data through the redirect chain.
  //
  // Instead: keep THIS page open (preserving the UGME URL) and open login
  // in a new tab via target="_blank" (pure HTML, no JS needed). A <meta>
  // refresh polls every 5s — once the customer is logged in, the proxy
  // sees logged_in_customer_id and serves the real content automatically.
  const html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8" />'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'
    + '<meta http-equiv="refresh" content="5" />'
    + '<title>Sign in to continue</title>'
    + '<style>'
    + '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }'
    + 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100dvh; background: #fff; color: #1a1a1a; }'
    + '.wrap { text-align: center; padding: 24px 20px; max-width: 360px; }'
    + '.icon { width: 64px; height: 64px; border-radius: 50%; background: #f3f4f6; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 28px; }'
    + 'h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }'
    + '.desc { color: #6b7280; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }'
    + '.btn { display: inline-block; padding: 14px 32px; background: #1a1a1a; color: #fff; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 15px; }'
    + '.btn:hover { opacity: 0.9; }'
    + '.hint { color: #9ca3af; font-size: 13px; margin-top: 16px; line-height: 1.5; }'
    + '</style>'
    + '</head><body>'
    + '<div class="wrap">'
    + '<div class="icon">&#128274;</div>'
    + '<h1>Sign in to continue</h1>'
    + '<p class="desc">Open the sign-in page, then come back to this tab.</p>'
    + '<a href="' + loginUrl + '" target="_blank" rel="noopener" class="btn">Sign in &#8599;</a>'
    + '<p class="hint">This page checks automatically.<br/>Once you are signed in it will load.</p>'
    + '</div>'
    + '</body></html>';
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Find-or-create a Customer record from the Shopify customer ID.
 *  Fetches the real email from Shopify Admin API on first encounter. */
async function findOrCreateCustomer(shopId: string, shopifyCustomerId: string, accessToken: string, shopDomain: string) {
  let customer = await prisma.customer.findFirst({
    where: { shopId, shopifyCustomerId },
  });

  if (customer) {
    // If we still have a placeholder email, try to backfill it
    if (customer.email.endsWith("@placeholder.ugme.app")) {
      const realEmail = await fetchCustomerEmail(shopDomain, accessToken, shopifyCustomerId);
      if (realEmail) {
        customer = await prisma.customer.update({
          where: { id: customer.id },
          data: { email: realEmail },
        });
      }
    }
    return customer;
  }

  // New customer — fetch real email from Shopify
  const email = await fetchCustomerEmail(shopDomain, accessToken, shopifyCustomerId) 
    || `customer-${shopifyCustomerId}@placeholder.ugme.app`;

  customer = await prisma.customer.create({
    data: {
      shopId,
      shopifyCustomerId,
      email,
    },
  });
  return customer;
}

/** Fetch customer email from Shopify Admin REST API */
async function fetchCustomerEmail(shopDomain: string, accessToken: string, customerId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/2024-10/customers/${customerId}.json?fields=id,email`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) {
      console.log("[UGME] fetchCustomerEmail failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    console.log("[UGME] fetchCustomerEmail result:", data?.customer?.email);
    return data?.customer?.email || null;
  } catch {
    return null;
  }
}

/** "Sam" — first name only, for customers who opt in to showing their name on the wall. */
async function customerDisplayName(shop: ShopInfo, shopifyCustomerId: string): Promise<string | null> {
  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    const gid = shopifyCustomerId.startsWith("gid://") ? shopifyCustomerId : `gid://shopify/Customer/${shopifyCustomerId}`;
    const res = await admin.graphql(`#graphql
      query WallCustomerName($id: ID!) { customer(id: $id) { firstName lastName } }`, { variables: { id: gid } });
    const body: any = await res.json();
    const first = String(body?.data?.customer?.firstName || "").trim().split(/\s+/)[0] || "";
    return first ? first.slice(0, 30) : null;
  } catch (err) {
    console.warn("[wall] couldn't read customer name:", err);
    return null;
  }
}

// ── Shared auth + shop resolution ───────────────────────────────

async function resolveRequest(request: Request) {
  const url = new URL(request.url);
  const { valid, shop: shopDomain, loggedInCustomerId } = verifyProxySignature(url);

  if (!valid || !shopDomain) {
    return { error: new Response("Unauthorized", { status: 401 }) };
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true, shopDomain: true, brandName: true, logoUrl: true, accessToken: true, subscriptionProvider: true, providerApiKey: true, providerConnected: true, planTier: true },
  });

  if (!shop) {
    return { error: new Response("Store not found", { status: 404 }) };
  }

  const brandName = shop.brandName || shop.shopDomain.replace(".myshopify.com", "");
  const proxyPath = url.pathname.replace(/^\/api\/proxy\/?/, "");

  return { shop, brandName, loggedInCustomerId, proxyPath, url };
}

// ── Loader (GET requests) ───────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const resolved = await resolveRequest(request);
  if ("error" in resolved) return resolved.error;
  const { shop, brandName, loggedInCustomerId, proxyPath, url } = resolved;

  // Route: /canvas — JSON for the Social Wall theme block (public, no login)
  if (proxyPath === "canvas") {
    return canvasJsonResponse(shop.id, url);
  }

  // Route: /campaign/:id/submitted
  const submittedMatch = proxyPath.match(/^campaign\/([^/]+)\/submitted$/);
  if (submittedMatch) {
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `${PROXY_BASE}/campaign/${submittedMatch[1]}/submitted`);
    return handleSubmitted(submittedMatch[1], shop, brandName, loggedInCustomerId, url);
  }

  // Route: /campaign/:id/submit
  const submitMatch = proxyPath.match(/^campaign\/([^/]+)\/submit$/);
  if (submitMatch) {
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `${PROXY_BASE}/campaign/${submitMatch[1]}/submit`);
    return handleSubmitForm(submitMatch[1], shop, brandName, loggedInCustomerId, url);
  }

  // Route: /campaign/:id
  const campaignMatch = proxyPath.match(/^campaign\/([^/]+)$/);
  if (campaignMatch) {
    return handleCampaignDetail(campaignMatch[1], shop, brandName, loggedInCustomerId);
  }

  // Route: /account/submission/:id (detail view)
  const submissionDetailMatch = proxyPath.match(/^account\/submission\/([^/]+)$/);
  if (submissionDetailMatch) {
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `${PROXY_BASE}/account/submission/${submissionDetailMatch[1]}`);
    return handleSubmissionDetail(submissionDetailMatch[1], shop, brandName, loggedInCustomerId);
  }

  // Route: /account
  if (proxyPath === "account") {
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `${PROXY_BASE}/account`);
    return handleAccount(shop, brandName, loggedInCustomerId);
  }

  // Route: / (campaign library)
  return handleCampaignLibrary(shop, brandName, loggedInCustomerId);
}

// ── Action (POST requests — form submission) ────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const resolved = await resolveRequest(request);
  if ("error" in resolved) return resolved.error;
  const { shop, brandName, loggedInCustomerId, proxyPath, url } = resolved;

  // POST /campaign/:id/upload-url — direct browser → R2 upload, step 1 (JSON)
  const uploadUrlMatch = proxyPath.match(/^campaign\/([^/]+)\/upload-url$/);
  if (uploadUrlMatch && request.method === "POST") {
    if (!loggedInCustomerId) return uploadJson({ error: "Please log in to submit." }, 401);
    return handleUploadUrl(uploadUrlMatch[1], shop, loggedInCustomerId, request);
  }

  // POST /campaign/:id/upload-abort — clean up a failed multipart upload (JSON)
  const abortMatch = proxyPath.match(/^campaign\/([^/]+)\/upload-abort$/);
  if (abortMatch && request.method === "POST") {
    if (!loggedInCustomerId) return uploadJson({ error: "Please log in to submit." }, 401);
    return handleUploadAbort(abortMatch[1], shop, loggedInCustomerId, request);
  }

  // POST /campaign/:id/complete — direct upload, step 2: verify + create submission (JSON)
  const completeMatch = proxyPath.match(/^campaign\/([^/]+)\/complete$/);
  if (completeMatch && request.method === "POST") {
    if (!loggedInCustomerId) return uploadJson({ error: "Please log in to submit." }, 401);
    return handleUploadComplete(completeMatch[1], shop, loggedInCustomerId, request);
  }

  // POST /campaign/:id/submit — process the submission (legacy multipart; fallback path)
  const submitMatch = proxyPath.match(/^campaign\/([^/]+)\/submit$/);
  if (submitMatch && request.method === "POST") {
    if (!loggedInCustomerId) {
      return new Response("Login required", { status: 401 });
    }
    return handleSubmitAction(submitMatch[1], shop, brandName, loggedInCustomerId, request);
  }

  // POST /account/submission/:id/delete — delete a submission
  const deleteMatch = proxyPath.match(/^account\/submission\/([^/]+)\/delete$/);
  if (deleteMatch && request.method === "POST") {
    if (!loggedInCustomerId) {
      return new Response("Login required", { status: 401 });
    }
    return handleDeleteSubmission(deleteMatch[1], shop, brandName, loggedInCustomerId);
  }

  return new Response("Not found", { status: 404 });
}

// ── C2.5: Campaign Library ──────────────────────────────────────

async function handleCampaignLibrary(shop: ShopInfo, brandName: string, loggedInCustomerId: string | null) {
  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id, status: "ACTIVE", rewardType: { not: "SUBSCRIPTION_DISCOUNT" } },
    select: {
      id: true,
      title: true,
      moment: true,
      contentType: true,
      rewardCycles: true, rewardFrequency: true,
      discountType: true,
      discountValue: true,
      rewardType: true,
      discountCodeAmount: true,
      discountCodeType: true,
      discountCodeExpiryDays: true,
      discountCodeMinOrder: true,
      storeCreditAmount: true,
      storeCreditExpiryDays: true,
      productScope: true,
      products: true,
      maxSubmissions: true,
      productTitle: true,
      productImageUrl: true,
      _count: { select: { submissions: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const slotsHtml = (c: (typeof campaigns)[0]) => {
    if (!c.maxSubmissions) return "";
    const remaining = Math.max(0, c.maxSubmissions - c._count.submissions);
    return `<span style="color: var(--ugme-muted); font-size: 13px;">${remaining} slot${remaining !== 1 ? "s" : ""} left</span>`;
  };

  const campaignCards = campaigns
    .map(
      (c) => `
    <a href="${PROXY_BASE}/campaign/${c.id}?shop=${shop.shopDomain}" style="text-decoration: none; color: inherit; display: block; border: 1px solid var(--ugme-border); border-radius: var(--ugme-radius); overflow: hidden; transition: box-shadow 0.15s ease;" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'" onmouseout="this.style.boxShadow='none'">
      <div style="padding: 16px;">
        <div style="display: flex; align-items: flex-start; gap: 12px;">
          ${
            parseProducts(c.products)[0]?.imageUrl || c.productImageUrl
              ? `<img src="${escapeHtml(parseProducts(c.products)[0]?.imageUrl || c.productImageUrl || "")}" alt="" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #f3f3f3;" />`
              : ""
          }
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 15px; margin-bottom: 2px;">For buyers of ${escapeHtml(productNames(c))}</div>
            <div style="font-size: 13px; color: var(--ugme-muted); margin-bottom: 8px;">${escapeHtml(c.moment)}</div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span class="ugme-badge ugme-badge--reward">${escapeHtml(rewardText(c))}</span>
              ${slotsHtml(c)}
            </div>
          </div>
          <span style="color: var(--ugme-muted); font-size: 18px;">›</span>
        </div>
      </div>
    </a>
  `,
    )
    .join("");

  const body = `
    <div class="ugme-section-label">${escapeHtml(brandName).toUpperCase()} SOCIAL WALL</div>
    <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px;">Get featured on our wall</h1>
    <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">
      Bought from us? Share a video of it in action. Approved posts appear on our Social Wall with a Verified buyer badge.
    </p>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${campaignCards || '<p style="color: var(--ugme-muted);">Nothing to share to right now — check back soon.</p>'}
    </div>
    <p style="font-size: 12px; color: var(--ugme-muted); margin-top: 24px;">
      One post per wall. Only verified buyers can share.
    </p>
  `;

  const html = proxyLayout({ title: "Social Wall", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── C3: Campaign Detail ─────────────────────────────────────────

async function handleCampaignDetail(campaignId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string | null) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      title: true,
      moment: true,
      contentType: true,
      captureSpecs: true,
      rewardCycles: true, rewardFrequency: true,
      discountType: true,
      discountValue: true,
      rewardType: true,
      discountCodeAmount: true,
      discountCodeType: true,
      discountCodeExpiryDays: true,
      discountCodeMinOrder: true,
      storeCreditAmount: true,
      storeCreditExpiryDays: true,
      productScope: true,
      products: true,
      maxSubmissions: true,
      endDate: true,
      status: true,
      shopId: true,
      productId: true,
      productTitle: true,
      productImageUrl: true,
      _count: { select: { submissions: true } },
    },
  });

  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    const body = `
      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
        <h1 style="font-size: 20px; margin-bottom: 8px;">This wall isn't open right now</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px;">It may have closed, or the link is out of date.</p>
        <a href="https://${shop.shopDomain}/" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Back to store</a>
      </div>
    `;
    const html = proxyLayout({ title: "Not Found", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // ── Verified buyers only ──
  if (loggedInCustomerId) {
    const check = await checkWallBuyer(shop, campaign, loggedInCustomerId);
    if (check.status !== "eligible") return buyerGatePage(check, shop, brandName, campaign);
  }

  let specs: Array<{ label: string; description: string }> = [];
  try {
    specs = JSON.parse(campaign.captureSpecs);
  } catch {
    specs = [];
  }

  const techSpecs = specs.filter((s) => s.label !== "Requirement");
  const requirements = specs.filter((s) => s.label === "Requirement");
  const reward = rewardText(campaign);

  const slotsRemaining = await spotsLeft(campaign);

  const deadlineHtml = campaign.endDate ? `closes ${new Date(campaign.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";

  const techSpecsHtml =
    techSpecs.length > 0
      ? `
    <div class="ugme-section-label">Production requirements</div>
    <ul style="list-style: none; padding: 0; margin: 0 0 24px 0; display: flex; flex-direction: column; gap: 6px;">
      ${techSpecs.map((s) => `<li style="display: flex; align-items: flex-start; gap: 8px; font-size: 14px;"><span style="color: var(--ugme-muted); margin-top: 1px;">•</span><span>${escapeHtml(s.label)}: <strong>${escapeHtml(s.description)}</strong></span></li>`).join("")}
    </ul>
  `
      : "";

  const requirementsHtml =
    requirements.length > 0
      ? `
    <div class="ugme-section-label">Content requirements</div>
    <ul style="list-style: none; padding: 0; margin: 0 0 24px 0; display: flex; flex-direction: column; gap: 6px;">
      ${requirements.map((s) => `<li style="display: flex; align-items: flex-start; gap: 8px; font-size: 14px;"><span style="color: var(--ugme-muted); margin-top: 1px;">•</span><span>${escapeHtml(s.description)}</span></li>`).join("")}
    </ul>
  `
      : "";

  const statsHtml =
    slotsRemaining !== null || deadlineHtml
      ? `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-top: 1px solid var(--ugme-border); border-bottom: 1px solid var(--ugme-border); margin-bottom: 24px; font-size: 13px;">
      ${slotsRemaining !== null ? `<span style="font-weight: 600;">${slotsRemaining === 0 ? "Wall is full" : spotsText(slotsRemaining)}</span>` : ""}
      ${deadlineHtml ? `<span style="color: var(--ugme-muted);">${deadlineHtml}</span>` : ""}
    </div>
  `
      : "";

  const body = `
    <div class="ugme-section-label">${escapeHtml(brandName).toUpperCase()} SOCIAL WALL</div>
    <h1 style="font-size: 24px; font-weight: 700; line-height: 1.3; margin-bottom: 12px;">Get featured on our wall</h1>
    <div style="margin-bottom: 20px;">
      <span class="ugme-badge ugme-badge--reward">${escapeHtml(reward)}</span>
    </div>

    <div class="ugme-section-label">What to share</div>
    <p style="font-size: 15px; margin-bottom: 24px; line-height: 1.6;">${escapeHtml(campaign.moment)}</p>

    ${techSpecsHtml}
    ${requirementsHtml}
    ${statsHtml}

    <a href="${PROXY_BASE}/campaign/${campaign.id}/submit?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--primary">
      Share your ${campaign.contentType === "VIDEO" ? "video" : "photo"}
    </a>

    <p style="font-size: 12px; color: var(--ugme-muted); margin-top: 16px; line-height: 1.5;">
      For verified buyers of ${escapeHtml(productNames(campaign))}. Approved ${campaign.contentType === "VIDEO" ? "videos" : "photos"} appear on the wall with a Verified buyer badge${hasReward(campaign) ? ` and earn ${escapeHtml(reward)}` : ""}.
    </p>
  `;

  const html = proxyLayout({ title: campaign.title, brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── C9: Upload & Submit Form ────────────────────────────────────

async function handleSubmitForm(campaignId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string, url: URL) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      title: true,
      moment: true,
      contentType: true,
      captureSpecs: true,
      rewardCycles: true, rewardFrequency: true,
      discountType: true,
      discountValue: true,
      rewardType: true,
      discountCodeAmount: true,
      discountCodeType: true,
      discountCodeExpiryDays: true,
      discountCodeMinOrder: true,
      storeCreditAmount: true,
      storeCreditExpiryDays: true,
      productScope: true,
      products: true,
      maxSubmissions: true,
      status: true,
      shopId: true,
      productId: true,
      productTitle: true,
      _count: { select: { submissions: true } },
    },
  });

  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    return new Response(null, {
      status: 302,
      headers: { Location: `${PROXY_BASE}/campaign/${campaignId}?shop=${shop.shopDomain}` },
    });
  }

  // Check if already submitted
  const customer = await findOrCreateCustomer(shop.id, loggedInCustomerId, shop.accessToken, shop.shopDomain);
  const existingSubmission = await prisma.submission.findFirst({
    where: { campaignId, customerId: customer.id, status: { not: "REJECTED" } },
  });

  if (existingSubmission) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${PROXY_BASE}/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` },
    });
  }

  // Check spots (submission limit)
  const remaining = await spotsLeft(campaign);
  {
    if (remaining !== null && remaining <= 0) {
      const body = `
        <div style="text-align: center; padding: 40px 0;">
          <div style="font-size: 48px; margin-bottom: 16px;">😔</div>
          <h1 style="font-size: 20px; margin-bottom: 8px;">This wall is full</h1>
          <p style="color: var(--ugme-muted); margin-bottom: 24px;">Thanks for your interest — it isn't taking new posts right now.</p>
          <a href="https://${shop.shopDomain}/" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Back to store</a>
        </div>
      `;
      const html = proxyLayout({ title: "Wall is full", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  }

  // ── Verified buyers only ──
  const buyer = await checkWallBuyer(shop, campaign, customer.shopifyCustomerId || loggedInCustomerId);
  if (buyer.status !== "eligible") return buyerGatePage(buyer, shop, brandName, campaign);
  const rewardWarningHtml = "";

  let specs: Array<{ label: string; description: string }> = [];
  try {
    specs = JSON.parse(campaign.captureSpecs);
  } catch {
    specs = [];
  }

  const requirements = specs.filter((s) => s.label === "Requirement");
  const reward = rewardText(campaign);
  const isVideo = campaign.contentType === "VIDEO";
  const mediaWord = isVideo ? "video" : "photo";

  // Error banner for upload failures
  const errorParam = url.searchParams.get("error");
  let errorBannerHtml = "";
  if (errorParam) {
    const errorMsgs: Record<string, string> = {
      no_file: "Please select a file to upload.",
      too_large: "File is too large. Maximum size is 1 GB.",
      upload_failed: "Upload failed. Please try again.",
      plan_limit: "This store can\u2019t accept new videos right now. Please try again later.",
    };
    const msg = errorMsgs[errorParam] || "Something went wrong. Please try again.";
    errorBannerHtml = '<div style="background: #fef2f2; color: #991b1b; padding: 14px 16px; border-radius: var(--ugme-radius); margin-bottom: 20px; font-size: 14px;">' + msg + '</div>';
  }

  const body = `
    <a href="https://${shop.shopDomain}/" style="display: inline-flex; align-items: center; gap: 4px; color: var(--ugme-muted); text-decoration: none; font-size: 14px; margin-bottom: 16px;">
      ← Back to store
    </a>

    <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 6px;">Share your ${mediaWord}</h1>
    <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 16px; line-height: 1.5;">
      Get featured on the ${escapeHtml(brandName)} Social Wall · <span class="ugme-badge ugme-badge--reward" style="font-size: 12px; padding: 2px 8px;">${escapeHtml(reward)}</span>
    </p>
    ${campaign.moment?.trim() ? `<div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 14px 16px; margin-bottom: 20px;"><div class="ugme-section-label" style="margin-bottom: 6px;">What to share</div><div style="font-size: 15px; line-height: 1.55;">${escapeHtml(campaign.moment)}</div></div>` : ""}
    ${remaining !== null && campaign.maxSubmissions ? spotsBarHtml(campaign.maxSubmissions - remaining, campaign.maxSubmissions) : ""}
    <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #047857; margin-bottom: 20px;"><span style="display: inline-flex; width: 18px; height: 18px; border-radius: 50%; background: #d1fae5; align-items: center; justify-content: center; font-size: 11px;">✓</span>Verified buyer of ${escapeHtml(buyer.products.map((p) => p.title).join(", ") || productNames(campaign))}</div>

    ${errorBannerHtml}
    ${rewardWarningHtml}
    <form id="submitForm" method="POST" action="${PROXY_BASE}/campaign/${campaign.id}/submit?shop=${shop.shopDomain}" enctype="multipart/form-data">

      <!-- File upload area -->
      <div id="uploadArea" style="border: 2px dashed var(--ugme-border); border-radius: var(--ugme-radius); padding: 40px 20px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; margin-bottom: 20px;" onclick="document.getElementById('fileInput').click()">
        <div id="uploadIcon" style="font-size: 36px; margin-bottom: 8px;">📱</div>
        <div id="uploadText" style="font-weight: 600; font-size: 15px; margin-bottom: 4px;">
          Tap to choose your ${mediaWord}
        </div>
        <div id="uploadHint" style="color: var(--ugme-muted); font-size: 13px;">
          ${isVideo ? "MP4 or MOV, max 1 GB" : "JPG or PNG, max 1 GB"}
        </div>
        <input type="file" id="fileInput" name="file" accept="${isVideo ? "video/mp4,video/quicktime,video/*" : "image/jpeg,image/png,image/*"}" style="display: none;" required />
      </div>

      <!-- File preview (hidden until file selected) -->
      <div id="filePreview" style="display: none; margin-bottom: 20px; border-radius: var(--ugme-radius); overflow: hidden; background: var(--ugme-surface);">
        ${isVideo ? '<video id="previewMedia" style="width: 100%; max-height: 300px; object-fit: contain; background: #000;" controls></video>' : '<img id="previewMedia" style="width: 100%; max-height: 300px; object-fit: contain;" alt="Preview" />'}
        <div style="padding: 12px; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <div id="fileName" style="font-weight: 600; font-size: 14px;"></div>
            <div id="fileSize" style="color: var(--ugme-muted); font-size: 13px;"></div>
          </div>
          <button type="button" id="removeFile" style="background: none; border: none; color: var(--ugme-muted); cursor: pointer; font-size: 18px; padding: 4px;">✕</button>
        </div>
      </div>

      <!-- Upload progress (hidden until uploading) -->
      <div id="uploadProgress" style="display: none; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span id="progressLabel" style="font-size: 14px; font-weight: 600;">Uploading…</span>
          <span id="progressPercent" style="font-size: 14px; color: var(--ugme-muted);">0%</span>
        </div>
        <div class="ugme-progress-bar">
          <div id="progressFill" class="ugme-progress-fill" style="width: 0%;"></div>
        </div>
        <div id="progressDetail" style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 13px; color: var(--ugme-muted);"><span id="progressBytes"></span><span id="progressEta"></span></div>
        <p style="margin-top: 10px; font-size: 13px; color: var(--ugme-muted);">Keep this page open until the upload finishes.</p>
      </div>
      <div id="uploadError" style="display: none; background: #fef2f2; color: #991b1b; padding: 14px 16px; border-radius: var(--ugme-radius); margin-bottom: 20px; font-size: 14px;"></div>

      ${
        requirements.length > 0
          ? `
      <!-- Requirements checklist -->
      <div class="ugme-section-label" style="margin-top: 8px;">Checklist</div>
      <div style="margin-bottom: 20px; display: flex; flex-direction: column; gap: 8px;">
        ${requirements
          .map(
            (r, i) => `
          <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; cursor: pointer; padding: 10px 12px; border-radius: var(--ugme-radius-sm); border: 1px solid var(--ugme-border); transition: background 0.15s;">
            <input type="checkbox" name="check_${i}" style="margin-top: 2px; accent-color: var(--ugme-accent); width: 18px; height: 18px; flex-shrink: 0;" />
            <span>${escapeHtml(r.description)}</span>
          </label>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      <!-- Name on the wall (opt-in) -->
      <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; cursor: pointer; padding: 12px; border-radius: var(--ugme-radius-sm); border: 1px solid var(--ugme-border); margin-bottom: 20px;">
        <input type="checkbox" name="showName" style="margin-top: 2px; accent-color: var(--ugme-accent); width: 18px; height: 18px; flex-shrink: 0;" />
        <span>Show my first name on the wall<br><span style="color: var(--ugme-muted); font-size: 13px;">Otherwise your post just shows “Verified buyer”.</span></span>
      </label>

      <!-- Optional message -->
      <div class="ugme-section-label">Message to ${escapeHtml(brandName)} (optional)</div>
      <textarea name="message" placeholder="Anything you want us to know about your ${mediaWord}…" style="width: 100%; min-height: 80px; border: 1px solid var(--ugme-border); border-radius: var(--ugme-radius-sm); padding: 12px; font-size: 14px; font-family: inherit; resize: vertical; margin-bottom: 20px; background: var(--ugme-bg); color: var(--ugme-fg);"></textarea>

      <!-- Terms agreement -->
      <div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 24px;">
        <div class="ugme-section-label" style="margin-bottom: 12px;">Rights & terms</div>
        <ul style="list-style: none; padding: 0; margin: 0 0 16px 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--ugme-muted); line-height: 1.5;">
          <li style="display: flex; gap: 8px;">
            <span style="flex-shrink: 0;">✓</span>
            <span>You own this content and have the right to share it.</span>
          </li>
          <li style="display: flex; gap: 8px;">
            <span style="flex-shrink: 0;">✓</span>
            <span>${escapeHtml(brandName)} may use your ${mediaWord} on their website, social media, and ads.</span>
          </li>
          <li style="display: flex; gap: 8px;">
            <span style="flex-shrink: 0;">✓</span>
            <span>${hasReward(campaign) ? `If approved, your ${mediaWord} appears on the Social Wall and your reward (${escapeHtml(reward)}) is sent to you by email.` : `If approved, your ${mediaWord} appears on the ${escapeHtml(brandName)} Social Wall.`}</span>
          </li>
          <li style="display: flex; gap: 8px;">
            <span style="flex-shrink: 0;">✓</span>
            <span>Posts are usually reviewed within 3–5 business days.</span>
          </li>
        </ul>
        <details style="margin: -4px 0 14px; font-size: 13px; color: var(--ugme-muted);">
          <summary style="cursor: pointer; color: var(--ugme-fg); font-weight: 600;">Read the full usage rights</summary>
          <p style="margin: 10px 0 6px; font-weight: 600; color: var(--ugme-fg);">${escapeHtml(USAGE_RIGHTS_INTRO)}</p>
          <ol style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; line-height: 1.5;">
            ${usageRightsClauses(brandName).map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
          </ol>
        </details>
        <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; cursor: pointer;">
          <input type="checkbox" id="termsCheckbox" name="terms" required style="margin-top: 2px; accent-color: var(--ugme-accent); width: 18px; height: 18px; flex-shrink: 0;" />
          <span>I agree to these terms and grant usage rights for my content.</span>
        </label>
      </div>

      <button type="submit" id="submitBtn" class="ugme-btn ugme-btn--primary" disabled style="opacity: 0.5; cursor: not-allowed;">
        Share ${mediaWord}
      </button>

      <p style="font-size: 12px; color: var(--ugme-muted); text-align: center; margin-top: 12px;">
        One post per wall. You can't edit after sharing.
      </p>
    </form>

    <script>
    (function() {
      const fileInput = document.getElementById('fileInput');
      const uploadArea = document.getElementById('uploadArea');
      const filePreview = document.getElementById('filePreview');
      const previewMedia = document.getElementById('previewMedia');
      const fileName = document.getElementById('fileName');
      const fileSize = document.getElementById('fileSize');
      const removeFile = document.getElementById('removeFile');
      const termsCheckbox = document.getElementById('termsCheckbox');
      const submitBtn = document.getElementById('submitBtn');
      const form = document.getElementById('submitForm');

      function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
      }

      function updateSubmitState() {
        const hasFile = fileInput.files && fileInput.files.length > 0;
        const termsChecked = termsCheckbox.checked;
        const canSubmit = hasFile && termsChecked;
        submitBtn.disabled = !canSubmit;
        submitBtn.style.opacity = canSubmit ? '1' : '0.5';
        submitBtn.style.cursor = canSubmit ? 'pointer' : 'not-allowed';
      }

      fileInput.addEventListener('change', function() {
        const file = this.files[0];
        if (!file) return;

        uploadArea.style.display = 'none';
        filePreview.style.display = 'block';
        fileName.textContent = file.name;
        fileSize.textContent = formatBytes(file.size);

        const url = URL.createObjectURL(file);
        previewMedia.src = url;

        updateSubmitState();
      });

      removeFile.addEventListener('click', function() {
        fileInput.value = '';
        uploadArea.style.display = 'block';
        filePreview.style.display = 'none';
        previewMedia.src = '';
        updateSubmitState();
      });

      termsCheckbox.addEventListener('change', updateSubmitState);

      // Drag & drop
      uploadArea.addEventListener('dragover', function(e) {
        e.preventDefault();
        this.style.borderColor = 'var(--ugme-accent)';
        this.style.background = 'var(--ugme-surface)';
      });
      uploadArea.addEventListener('dragleave', function() {
        this.style.borderColor = 'var(--ugme-border)';
        this.style.background = 'transparent';
      });
      uploadArea.addEventListener('drop', function(e) {
        e.preventDefault();
        this.style.borderColor = 'var(--ugme-border)';
        this.style.background = 'transparent';
        if (e.dataTransfer.files.length) {
          fileInput.files = e.dataTransfer.files;
          fileInput.dispatchEvent(new Event('change'));
        }
      });

      // ── Upload: browser → R2 directly, with real progress ──────────
      // 1) ask the app for a presigned URL, 2) PUT the file straight to R2,
      // 3) tell the app it landed. Falls back to the old multipart submit if
      // the direct upload can't start (e.g. bucket CORS not configured).
      const progressBox = document.getElementById('uploadProgress');
      const progressLabel = document.getElementById('progressLabel');
      const progressPercent = document.getElementById('progressPercent');
      const progressFill = document.getElementById('progressFill');
      const progressBytes = document.getElementById('progressBytes');
      const progressEta = document.getElementById('progressEta');
      const uploadError = document.getElementById('uploadError');
      const actionUrl = form.getAttribute('action');
      const qIndex = actionUrl.indexOf('?');
      const actionPath = qIndex >= 0 ? actionUrl.slice(0, qIndex) : actionUrl;
      const actionQuery = qIndex >= 0 ? actionUrl.slice(qIndex) : '';
      const stepUrl = function(step) { return actionPath.replace(/submit$/, step) + actionQuery; };
      let busy = false;
      let wakeLock = null;

      function guardUnload(e) { e.preventDefault(); e.returnValue = ''; return ''; }

      function setBusy(on) {
        busy = on;
        submitBtn.disabled = on;
        submitBtn.style.opacity = on ? '0.7' : '1';
        submitBtn.style.cursor = on ? 'progress' : 'pointer';
        removeFile.style.display = on ? 'none' : '';
        if (on) {
          window.addEventListener('beforeunload', guardUnload);
          if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function(l) { wakeLock = l; }).catch(function() {});
        } else {
          window.removeEventListener('beforeunload', guardUnload);
          if (wakeLock) { wakeLock.release().catch(function() {}); wakeLock = null; }
        }
      }

      function fmtEta(sec) {
        if (!isFinite(sec) || sec <= 0) return '';
        if (sec < 60) return 'about ' + Math.max(1, Math.round(sec)) + 's left';
        return 'about ' + Math.round(sec / 60) + ' min left';
      }

      function showProgress(label, pct, loaded, total, eta) {
        progressBox.style.display = 'block';
        uploadError.style.display = 'none';
        progressLabel.textContent = label;
        if (pct == null) {
          progressPercent.textContent = '';
          progressFill.style.width = '100%';
          progressFill.style.opacity = '0.5';
        } else {
          progressPercent.textContent = Math.floor(pct) + '%';
          progressFill.style.width = pct + '%';
          progressFill.style.opacity = '1';
        }
        progressBytes.textContent = total ? formatBytes(loaded) + ' of ' + formatBytes(total) : '';
        progressEta.textContent = eta || '';
      }

      function fail(msg) {
        setBusy(false);
        progressBox.style.display = 'none';
        uploadError.textContent = msg || 'Upload failed. Please try again.';
        uploadError.style.display = 'block';
        submitBtn.textContent = 'Try again';
        uploadError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      function nativeFallback() {
        // Old path: multipart POST through the app proxy (no progress available).
        form.dataset.native = '1';
        showProgress('Uploading… this can take a few minutes for large videos', null, 0, 0, '');
        window.removeEventListener('beforeunload', guardUnload);
        HTMLFormElement.prototype.submit.call(form);
      }

      function postJson(url, data) {
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(data),
        }).then(function(res) {
          return res.json().catch(function() { return {}; }).then(function(json) { return { ok: res.ok, json: json }; });
        });
      }

      const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
      const LEGACY_MAX_BYTES = 100 * 1024 * 1024; // old proxy path limit

      // Single PUT of a Blob with progress. Resolves with the response ETag.
      function putBlob(url, blob, contentType, onProgress, register) {
        return new Promise(function(resolve, reject) {
          const xhr = new XMLHttpRequest();
          if (register) register(xhr);
          xhr.open('PUT', url);
          if (contentType) xhr.setRequestHeader('Content-Type', contentType);
          xhr.upload.onprogress = function(e) { if (e.lengthComputable) onProgress(e.loaded); };
          xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'));
            else reject({ status: xhr.status });
          };
          xhr.onerror = function() { reject({ status: 0 }); };
          xhr.onabort = function() { reject({ status: -1 }); };
          xhr.send(blob);
        });
      }

      function makeProgress(file) {
        const started = Date.now();
        let rate = 0, lastT = started, lastLoaded = 0;
        const word = file.type.indexOf('video') === 0 ? 'video' : 'photo';
        return function(loaded) {
          const now = Date.now();
          const dt = (now - lastT) / 1000;
          if (dt > 0.5) {
            const inst = (loaded - lastLoaded) / dt;
            rate = rate ? rate * 0.7 + inst * 0.3 : inst;
            lastT = now; lastLoaded = loaded;
          }
          const pct = Math.min(99.5, (loaded / file.size) * 100);
          showProgress('Uploading your ' + word + '…', pct, loaded, file.size, rate > 0 ? fmtEta((file.size - loaded) / rate) : '');
        };
      }

      // Large files: R2 multipart — 16 MB parts, 4 in parallel, each retried up to 4 times.
      async function uploadMultipart(ticket, file) {
        const report = makeProgress(file);
        const partLoaded = new Array(ticket.partUrls.length).fill(0);
        const etags = new Array(ticket.partUrls.length);
        const sum = function() { return partLoaded.reduce(function(a, b) { return a + b; }, 0); };
        let next = 0, anyStarted = false;

        async function sendPart(i) {
          const start = i * ticket.partSize;
          const blob = file.slice(start, Math.min(start + ticket.partSize, file.size));
          for (let attempt = 0; ; attempt++) {
            try {
              const etag = await putBlob(ticket.partUrls[i], blob, null, function(loaded) {
                partLoaded[i] = loaded; anyStarted = anyStarted || loaded > 0; report(sum());
              });
              if (!etag) throw { status: 0, noEtag: true };
              etags[i] = etag;
              partLoaded[i] = blob.size; report(sum());
              return;
            } catch (err) {
              partLoaded[i] = 0;
              if (err && err.noEtag) throw err; // CORS ExposeHeaders missing — retrying won't help
              if (attempt >= 3) throw err;
              showProgress('Connection hiccup — retrying…', (sum() / file.size) * 100, sum(), file.size, '');
              await new Promise(function(r) { setTimeout(r, 1000 * Math.pow(2, attempt)); });
            }
          }
        }

        async function worker() {
          while (next < ticket.partUrls.length) {
            const i = next++;
            await sendPart(i);
          }
        }

        try {
          await Promise.all([worker(), worker(), worker(), worker()]);
        } catch (err) {
          postJson(stepUrl('upload-abort'), { key: ticket.key, uploadId: ticket.uploadId, token: ticket.token, expires: ticket.expires }).catch(function() {});
          err = err || {}; err.started = anyStarted; throw err;
        }
        return etags.map(function(etag, i) { return { PartNumber: i + 1, ETag: etag }; });
      }

      // ── Poster: grab a frame (video) or downscale (photo) from the LOCAL file,
      // so the Social Wall gets a tiny thumbnail instead of decoding the video
      // in every shopper's browser. Best-effort: failures never block submitting.
      const POSTER_MAX = 800;
      let posterPromise = null;

      function canvasFrom(source, w, h) {
        const scale = Math.min(1, POSTER_MAX / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(w * scale));
        c.height = Math.max(2, Math.round(h * scale));
        c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
        return c;
      }

      function looksEmpty(c) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const step = Math.max(4, Math.floor((c.width * c.height) / 400)) * 4;
        let maxLum = 0, opaque = false;
        for (let i = 0; i < d.length; i += step) {
          if (d[i + 3] !== 0) opaque = true;
          const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          if (lum > maxLum) maxLum = lum;
        }
        return !opaque || maxLum < 12;
      }

      function toJpeg(c) {
        return new Promise(function(resolve) { c.toBlob(function(b) { resolve(b); }, 'image/jpeg', 0.82); });
      }

      function photoPoster(file) {
        return new Promise(function(resolve) {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = function() {
            const c = canvasFrom(img, img.naturalWidth, img.naturalHeight);
            URL.revokeObjectURL(url);
            toJpeg(c).then(function(blob) { resolve({ blob: blob, duration: null }); });
          };
          img.onerror = function() { URL.revokeObjectURL(url); resolve(null); };
          img.src = url;
        });
      }

      function videoPoster(file) {
        return new Promise(function(resolve) {
          const url = URL.createObjectURL(file);
          const v = document.createElement('video');
          // iOS only decodes frames for muted, inline, on-page videos that have played.
          v.muted = true; v.defaultMuted = true; v.setAttribute('muted', '');
          v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
          v.preload = 'auto';
          v.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px;height:640px;opacity:0;pointer-events:none;';
          document.body.appendChild(v);
          let done = false, tries = 0, t = 0.5;
          const finish = function(result) {
            if (done) return; done = true; clearTimeout(timer);
            v.pause(); v.removeAttribute('src'); v.load(); v.remove(); URL.revokeObjectURL(url);
            resolve(result);
          };
          const timer = setTimeout(function() { finish(null); }, 12000);
          const draw = function() {
            if (done) return;
            try {
              const c = canvasFrom(v, v.videoWidth || 720, v.videoHeight || 1280);
              if (looksEmpty(c) && tries++ < 10) {
                if (tries % 3 === 0 && isFinite(v.duration)) { t = Math.min(t + 0.75, Math.max(0, v.duration - 0.1)); v.currentTime = t; return; }
                setTimeout(draw, 150); return;
              }
              toJpeg(c).then(function(blob) { finish({ blob: blob, duration: isFinite(v.duration) ? v.duration : null }); });
            } catch (e) { finish(null); }
          };
          const whenReady = function() {
            if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(function() { draw(); }); setTimeout(draw, 400); }
            else setTimeout(draw, 80);
          };
          v.addEventListener('seeked', function() {
            if (v.readyState >= 2) whenReady(); else v.addEventListener('loadeddata', whenReady, { once: true });
          });
          v.addEventListener('loadedmetadata', function() {
            t = isFinite(v.duration) ? Math.min(0.5, v.duration / 3) : 0.1;
            const seek = function() { v.pause(); v.currentTime = t; };
            const p = v.play();
            if (p && p.then) p.then(function() { setTimeout(seek, 50); }).catch(seek); else seek();
          });
          v.addEventListener('error', function() { finish(null); });
          v.src = url; v.load();
        });
      }

      function makePoster(file) {
        if (!posterPromise) {
          posterPromise = (file.type.indexOf('video') === 0 ? videoPoster(file) : photoPoster(file)).catch(function() { return null; });
        }
        return posterPromise;
      }

      fileInput.addEventListener('change', function() { posterPromise = null; });
      removeFile.addEventListener('click', function() { posterPromise = null; });

      async function uploadPoster(ticket, file) {
        if (!ticket.posterUploadUrl) return { ok: false, duration: null };
        const poster = await makePoster(file);
        if (!poster || !poster.blob) return { ok: false, duration: null };
        try {
          await putBlob(ticket.posterUploadUrl, poster.blob, 'image/jpeg', function() {});
          return { ok: true, duration: poster.duration };
        } catch (e) {
          return { ok: false, duration: poster.duration };
        }
      }

      async function directUpload() {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > MAX_BYTES) return fail('File is too large. Maximum size is 1 GB.');
        setBusy(true);
        submitBtn.textContent = 'Uploading…';
        showProgress('Preparing upload…', 0, 0, file.size, '');

        let ticket;
        try {
          const r = await postJson(stepUrl('upload-url'), { fileName: file.name, fileType: file.type, fileSize: file.size });
          if (r.json.redirect) { setBusy(false); window.location.href = r.json.redirect; return; }
          if (!r.ok) return fail(r.json.error);
          ticket = r.json;
        } catch (err) {
          return file.size <= LEGACY_MAX_BYTES ? nativeFallback() : fail('Upload couldn\u2019t start. Please try again.');
        }

        makePoster(file); // start decoding the thumbnail while the upload runs
        const posterUpload = uploadPoster(ticket, file);

        let parts = null;
        try {
          if (ticket.mode === 'multipart') {
            parts = await uploadMultipart(ticket, file);
          } else {
            const report = makeProgress(file);
            await putBlob(ticket.uploadUrl, file, ticket.contentType, report).catch(function(err) {
              err = err || {}; err.started = true; throw err;
            });
          }
        } catch (err) {
          // Couldn't reach storage at all (e.g. bucket CORS not set) → old path for small files.
          if (err && err.status === 0 && !err.started && file.size <= LEGACY_MAX_BYTES) return nativeFallback();
          return fail('Upload interrupted. Check your connection and try again.');
        }

        showProgress('Finishing up…', 100, file.size, file.size, '');
        const fields = new FormData(form);
        const poster = await Promise.race([
          posterUpload,
          new Promise(function(r) { setTimeout(function() { r({ ok: false, duration: null }); }, 8000); }),
        ]);
        try {
          const r = await postJson(stepUrl('complete'), {
            hasPoster: !!poster.ok,
            durationSecs: poster.duration,
            key: ticket.key,
            uploadId: ticket.uploadId || '',
            parts: parts,
            token: ticket.token,
            expires: ticket.expires,
            message: fields.get('message') || '',
            showName: fields.get('showName') === 'on',
          });
          if (r.json.redirect) {
            setBusy(false);
            submitBtn.textContent = 'Submitted ✓';
            window.location.href = r.json.redirect;
            return;
          }
          return fail(r.json.error);
        } catch (err) {
          return fail('We couldn\u2019t confirm your upload. Please try again.');
        }
      }

      // Large file on mobile data? Give a heads-up before they start.
      fileInput.addEventListener('change', function() {
        const f = this.files && this.files[0];
        const hint = document.getElementById('sizeHint');
        if (hint) hint.remove();
        if (!f) return;
        if (f.size > MAX_BYTES) {
          fail('This file is ' + formatBytes(f.size) + '. The maximum is 1 GB \u2014 try trimming the video.');
          submitBtn.disabled = true;
          return;
        }
        if (f.size > 200 * 1024 * 1024) {
          const p = document.createElement('p');
          p.id = 'sizeHint';
          p.style.cssText = 'margin: -8px 0 16px; font-size: 13px; color: var(--ugme-muted);';
          p.textContent = 'Large file (' + formatBytes(f.size) + '). Wi-Fi recommended \u2014 keep this page open while it uploads.';
          filePreview.after(p);
        }
      });

      form.addEventListener('submit', function(e) {
        if (form.dataset.native === '1') return; // fallback in progress
        e.preventDefault();
        if (busy) return;
        if (!window.fetch || !window.XMLHttpRequest || !window.FormData) return nativeFallback();
        directUpload();
      });
    })();
    </script>
  `;

  const html = proxyLayout({ title: "Submit", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── C9 POST: Process submission ─────────────────────────────────

// Direct-to-R2 uploads (browser → R2) handle up to 1 GB. The legacy multipart
// path streams through the app proxy and buffers in memory, so it stays at 100 MB.
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
const LEGACY_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
const MULTIPART_THRESHOLD = 64 * 1024 * 1024; // files above this upload in parts
const PART_SIZE = 16 * 1024 * 1024; // 16 MB parts (1 GB → 64 parts)

async function handleSubmitAction(campaignId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string, request: Request) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, title: true, shopId: true, status: true, contentType: true, productId: true, rewardType: true, productScope: true, products: true, maxSubmissions: true },
  });

  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    return new Response(null, {
      status: 302,
      headers: { Location: `${PROXY_BASE}?shop=${shop.shopDomain}` },
    });
  }

  const customer = await findOrCreateCustomer(shop.id, loggedInCustomerId, shop.accessToken, shop.shopDomain);

  // ── Verified buyers only ──
  const buyer = await checkWallBuyer(shop, campaign, customer.shopifyCustomerId || loggedInCustomerId);
  if (buyer.status !== "eligible") return errorRedirect(shop.shopDomain, campaignId, buyer.status === "not_buyer" ? "not_buyer" : "verify_failed");

  // Check duplicate
  const existing = await prisma.submission.findFirst({
    where: { campaignId, customerId: customer.id, status: { not: "REJECTED" } },
  });
  if (existing) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${PROXY_BASE}/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` },
    });
  }

  const left = await spotsLeft(campaign);
  if (left !== null && left <= 0) return errorRedirect(shop.shopDomain, campaignId, "full");

  // Parse the multipart form data
  let description = "";
  let showName = false;
  let file: File | null = null;
  try {
    const formData = await request.formData();
    description = (formData.get("message") as string) || "";
    showName = formData.get("showName") === "on";
    file = formData.get("file") as File | null;
  } catch (err) {
    console.error("[UGME] Form parse error:", err);
    return errorRedirect(shop.shopDomain, campaignId, "upload_failed");
  }

  if (!file || file.size === 0) {
    return errorRedirect(shop.shopDomain, campaignId, "no_file");
  }

  // ── Plan gating: check storage + monthly submission limits ──
  try {
    const gates = await checkPlanGates(shop.id, (shop.planTier as PlanTierKey) || "FREE", file.size);
    if (!gates.canAcceptSubmission) {
      return errorRedirect(shop.shopDomain, campaignId, "plan_limit");
    }
  } catch (err) {
    console.error("[UGME] Plan gate check failed:", err);
    // Fail open — don't block submissions if the check errors
  }

  if (file.size > LEGACY_MAX_UPLOAD_BYTES) {
    return errorRedirect(shop.shopDomain, campaignId, "too_large");
  }

  // Create the submission first (so we have an ID for the object key)
  const submission = await prisma.submission.create({
    data: {
      campaignId,
      customerId: customer.id,
      contentType: campaign.contentType,
      contentUrl: "r2://pending", // temporary, updated after upload
      fileBytes: file.size,
      description: description || null,
      products: JSON.stringify(buyer.products),
      displayName: showName ? await customerDisplayName(shop, customer.shopifyCustomerId || loggedInCustomerId) : null,
      rightsAccepted: true,
    },
  });

  // Upload file to R2
  try {
    const objectKey = buildObjectKey(shop.shopDomain, campaign.title, submission.id, file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadToR2(objectKey, buffer, file.type || "application/octet-stream");

    // Update submission with the real R2 key
    await prisma.submission.update({
      where: { id: submission.id },
      data: { contentUrl: `r2://${objectKey}` },
    });
  } catch (err) {
    console.error("[UGME] R2 upload error:", err);
    // Clean up the submission record on upload failure
    await prisma.submission.delete({ where: { id: submission.id } });
    return errorRedirect(shop.shopDomain, campaignId, "upload_failed");
  }

  // Redirect to confirmation
  return new Response(null, {
    status: 302,
    headers: { Location: `${PROXY_BASE}/campaign/${campaignId}/submitted?shop=${shop.shopDomain}` },
  });
}

// ── Direct browser → R2 upload ──────────────────────────────────
// The browser PUTs the file straight to R2 (with a real progress bar) instead of
// streaming it through Shopify's app proxy → tunnel → this server → R2. The
// legacy multipart /submit route above stays as an automatic fallback.

const UPLOAD_ERRORS: Record<string, string> = {
  no_file: "Please select a file to upload.",
  too_large: "File is too large. Maximum size is 1 GB.",
  wrong_type: "That file type isn't accepted here.",
  upload_failed: "Upload failed. Please try again.",
  plan_limit: "This store can’t accept new videos right now. Please try again later.",
  not_buyer: "Only verified buyers can share to this wall.",
  verify_failed: "We couldn’t confirm your purchase right now. Please try again in a moment.",
  closed: "This wall isn’t accepting posts right now.",
  full: "This wall is full — it isn’t taking new posts right now.",
  expired: "Your upload session expired. Please try again.",
};

function uploadJson(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function uploadError(reason: string, status = 400, extra: Record<string, unknown> = {}) {
  return uploadJson({ error: UPLOAD_ERRORS[reason] || UPLOAD_ERRORS.upload_failed, reason, ...extra }, status);
}

function signUpload(parts: string[]): string {
  const secret = process.env.SHOPIFY_API_SECRET || "ugme-dev-upload-secret";
  return crypto.createHmac("sha256", secret).update(parts.join("|")).digest("hex");
}

/** Same checks as the multipart submit: campaign open, subscription (Recharge), one per customer. */
async function preflightSubmission(campaignId: string, shop: ShopInfo, loggedInCustomerId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, title: true, shopId: true, status: true, contentType: true, productId: true, rewardType: true, productScope: true, products: true, maxSubmissions: true },
  });
  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    return { ok: false as const, response: uploadError("closed", 409) };
  }

  const customer = await findOrCreateCustomer(shop.id, loggedInCustomerId, shop.accessToken, shop.shopDomain);

  // Verified buyers only — also tells us which wall products they bought
  const buyer = await checkWallBuyer(shop, campaign, customer.shopifyCustomerId || loggedInCustomerId);
  if (buyer.status === "not_buyer") return { ok: false as const, response: uploadError("not_buyer", 403) };
  if (buyer.status === "error") return { ok: false as const, response: uploadError("verify_failed", 503) };
  const products = buyer.products;

  const existing = await prisma.submission.findFirst({
    where: { campaignId, customerId: customer.id, status: { not: "REJECTED" } },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false as const,
      response: uploadJson({ redirect: `${PROXY_BASE}/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` }, 409),
    };
  }

  // Submission limit — checked last so customers who already shared get their own message
  const left = await spotsLeft(campaign);
  if (left !== null && left <= 0) return { ok: false as const, response: uploadError("full", 409) };

  return { ok: true as const, campaign, customer, products };
}

function verifyUploadToken(given: string, parts: string[]): boolean {
  const expected = signUpload(parts);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function handleUploadAbort(campaignId: string, shop: ShopInfo, loggedInCustomerId: string, request: Request) {
  try {
    const body = (await request.json()) as { key?: string; uploadId?: string; token?: string; expires?: number };
    const customer = await prisma.customer.findFirst({ where: { shopId: shop.id, shopifyCustomerId: loggedInCustomerId } });
    const key = String(body.key || "");
    const uploadId = String(body.uploadId || "");
    if (customer && uploadId && verifyUploadToken(String(body.token || ""), [shop.id, campaignId, customer.id, key, uploadId, String(body.expires || 0)])) {
      await abortMultipartUpload(key, uploadId);
    }
  } catch (err) {
    console.warn("[UGME] abort multipart failed:", err);
  }
  return uploadJson({ ok: true });
}

async function handleUploadUrl(campaignId: string, shop: ShopInfo, loggedInCustomerId: string, request: Request) {
  let body: { fileName?: string; fileType?: string; fileSize?: number };
  try {
    body = await request.json();
  } catch {
    return uploadError("upload_failed");
  }
  const fileName = String(body.fileName || "upload").slice(0, 200);
  const fileType = String(body.fileType || "");
  const fileSize = Number(body.fileSize || 0);

  if (!fileSize) return uploadError("no_file");
  if (fileSize > MAX_UPLOAD_BYTES) return uploadError("too_large", 413);

  const pre = await preflightSubmission(campaignId, shop, loggedInCustomerId);
  if (!pre.ok) return pre.response;

  const wantVideo = pre.campaign.contentType === "VIDEO";
  if (fileType && !fileType.startsWith(wantVideo ? "video/" : "image/")) return uploadError("wrong_type", 415);

  try {
    const gates = await checkPlanGates(shop.id, (shop.planTier as PlanTierKey) || "FREE", fileSize);
    if (!gates.canAcceptSubmission) return uploadError("plan_limit", 402);
  } catch (err) {
    console.error("[UGME] Plan gate check failed:", err);
  }

  const folderId = crypto.randomUUID();
  const key = buildObjectKey(shop.shopDomain, pre.campaign.title, folderId, fileName);
  const contentType = fileType || "application/octet-stream";
  const ttlSecs = 6 * 60 * 60; // 6h to finish (1 GB on a slow connection)
  const expires = Date.now() + ttlSecs * 1000;

  // Small JPEG thumbnail the browser generates from the local file while uploading.
  const posterKey = posterKeyFor(key);
  const posterUploadUrl = await getPresignedUploadUrl(posterKey, "image/jpeg", ttlSecs);

  if (fileSize > MULTIPART_THRESHOLD) {
    const uploadId = await createMultipartUpload(key, contentType);
    const partCount = Math.ceil(fileSize / PART_SIZE);
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) => getPresignedPartUrl(key, uploadId, i + 1, ttlSecs)),
    );
    const token = signUpload([shop.id, campaignId, pre.customer.id, key, uploadId, String(expires)]);
    return uploadJson({ mode: "multipart", key, uploadId, partSize: PART_SIZE, partUrls, contentType, expires, token, posterUploadUrl });
  }

  const uploadUrl = await getPresignedUploadUrl(key, contentType, ttlSecs);
  const token = signUpload([shop.id, campaignId, pre.customer.id, key, "", String(expires)]);
  return uploadJson({ mode: "single", uploadUrl, key, uploadId: "", contentType, expires, token, posterUploadUrl });
}

async function handleUploadComplete(campaignId: string, shop: ShopInfo, loggedInCustomerId: string, request: Request) {
  let body: {
    key?: string;
    uploadId?: string;
    parts?: { PartNumber: number; ETag: string }[];
    token?: string;
    expires?: number;
    message?: string;
    showName?: boolean;
    hasPoster?: boolean;
    durationSecs?: number;
  };
  try {
    body = await request.json();
  } catch {
    return uploadError("upload_failed");
  }
  const key = String(body.key || "");
  const uploadId = String(body.uploadId || "");
  const expires = Number(body.expires || 0);

  const pre = await preflightSubmission(campaignId, shop, loggedInCustomerId);
  if (!pre.ok) return pre.response;

  if (!verifyUploadToken(String(body.token || ""), [shop.id, campaignId, pre.customer.id, key, uploadId, String(expires)])
      || !key.startsWith(`${shop.shopDomain}/`)) {
    return uploadError("upload_failed", 403);
  }
  if (Date.now() > expires) return uploadError("expired", 410);

  if (uploadId) {
    const parts = (body.parts || [])
      .map((p) => ({ PartNumber: Number(p.PartNumber), ETag: String(p.ETag || "") }))
      .filter((p) => p.PartNumber > 0 && p.ETag);
    if (!parts.length) return uploadError("upload_failed", 422);
    try {
      await completeMultipartUpload(key, uploadId, parts);
    } catch (err) {
      console.error("[UGME] completeMultipartUpload failed:", err);
      await abortMultipartUpload(key, uploadId).catch(() => {});
      return uploadError("upload_failed", 422);
    }
  }

  const head = await headObject(key).catch((err) => {
    console.error("[UGME] headObject failed:", err);
    return null;
  });
  if (!head || head.size === 0) return uploadError("upload_failed", 422);
  if (head.size > MAX_UPLOAD_BYTES) {
    await deleteObject(key).catch(() => {});
    return uploadError("too_large", 413);
  }

  // Poster is optional (the browser may not manage to grab a frame) — only store
  // it if it really landed in R2.
  let thumbnailUrl: string | null = null;
  if (body.hasPoster) {
    const posterKey = posterKeyFor(key);
    const poster = await headObject(posterKey).catch(() => null);
    if (poster && poster.size > 0 && poster.size < 5 * 1024 * 1024) thumbnailUrl = `r2://${posterKey}`;
  }
  const durationSecs =
    Number.isFinite(Number(body.durationSecs)) && Number(body.durationSecs) > 0
      ? Math.round(Number(body.durationSecs))
      : null;

  await prisma.submission.create({
    data: {
      campaignId,
      customerId: pre.customer.id,
      contentType: pre.campaign.contentType,
      contentUrl: `r2://${key}`,
      thumbnailUrl,
      durationSecs,
      fileBytes: head.size,
      description: (body.message || "").slice(0, 2000) || null,
      // Resolved on the server from the customer's orders — never trusted from the browser
      products: JSON.stringify(pre.products),
      displayName: body.showName ? await customerDisplayName(shop, pre.customer.shopifyCustomerId || loggedInCustomerId) : null,
      rightsAccepted: true,
    },
  });

  return uploadJson({ redirect: `${PROXY_BASE}/campaign/${campaignId}/submitted?shop=${shop.shopDomain}` });
}

function errorRedirect(shopDomain: string, campaignId: string, reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${PROXY_BASE}/campaign/${campaignId}/submit?shop=${shopDomain}&error=${reason}` },
  });
}

// ── C10: Submitted Confirmation ─────────────────────────────────

async function handleSubmitted(campaignId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string, url?: URL) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      title: true,
      rewardCycles: true, rewardFrequency: true,
      discountType: true,
      discountValue: true,
      rewardType: true,
      discountCodeAmount: true,
      discountCodeType: true,
      discountCodeExpiryDays: true,
      discountCodeMinOrder: true,
      storeCreditAmount: true,
      storeCreditExpiryDays: true,
      productScope: true,
      products: true,
      contentType: true,
      shopId: true,
    },
  });

  const reward = campaign ? rewardText(campaign) : "your reward";
  const mediaWord = campaign?.contentType === "VIDEO" ? "video" : "photo";

  // Show the customer's real status — this page is also where they land when
  // they open the share link again after already posting.
  const customer = await prisma.customer.findFirst({ where: { shopId: shop.id, shopifyCustomerId: loggedInCustomerId } });
  const mine = customer
    ? await prisma.submission.findFirst({
        where: { campaignId, customerId: customer.id, status: { not: "REJECTED" } },
        orderBy: { createdAt: "desc" },
        include: { reward: true },
      })
    : null;

  if (mine && mine.status === "APPROVED" && campaign) {
    const r = mine.reward;
    const delivered = r?.status === "APPLIED";
    let rewardBox: string;
    if (!hasReward(campaign)) {
      rewardBox = `<div style="font-size: 15px; font-weight: 600; color: #065f46;">Featured with a Verified buyer badge</div>`;
    } else if (delivered && r?.rewardType === "DISCOUNT_CODE" && r.discountCode) {
      rewardBox = `
        <div class="ugme-section-label" style="color: #065f46; margin-bottom: 6px;">Your reward</div>
        <div style="font-size: 15px; font-weight: 600; color: #065f46; margin-bottom: 10px;">${escapeHtml(reward)}</div>
        <code style="display: inline-block; font-family: ui-monospace, Menlo, monospace; font-size: 18px; font-weight: 700; letter-spacing: 0.04em; background: #fff; border: 2px dashed #10b981; color: #064e3b; padding: 10px 14px; border-radius: 10px;">${escapeHtml(r.discountCode)}</code>
        <div style="margin-top: 12px;"><a href="https://${shop.shopDomain}/discount/${encodeURIComponent(r.discountCode)}?redirect=%2F" style="color: #047857; font-weight: 600; font-size: 14px;">Shop now — code applied automatically →</a></div>`;
    } else if (delivered && r?.rewardType === "STORE_CREDIT") {
      rewardBox = `
        <div class="ugme-section-label" style="color: #065f46; margin-bottom: 6px;">Your reward</div>
        <div style="font-size: 15px; font-weight: 600; color: #065f46;">${escapeHtml(reward)} added to your account</div>
        <div style="font-size: 13px; color: #047857; margin-top: 6px;">Sign in when you shop and apply it at checkout.</div>`;
    } else {
      rewardBox = `
        <div class="ugme-section-label" style="color: #065f46; margin-bottom: 6px;">Your reward</div>
        <div style="font-size: 15px; font-weight: 600; color: #065f46;">${escapeHtml(reward)}</div>
        <div style="font-size: 13px; color: #047857; margin-top: 6px;">On its way — we'll email it to you shortly.</div>`;
    }
    const body = `
      <div style="text-align: center; padding: 24px 0;">
        <div style="width: 64px; height: 64px; border-radius: 50%; background: #ecfdf5; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 28px;">🎉</div>
        <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">You're on the wall!</h1>
        <p style="color: var(--ugme-muted); font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
          Your ${mediaWord} was approved and is live on the ${escapeHtml(brandName)} Social Wall.
        </p>
        <div style="background: #ecfdf5; border-radius: var(--ugme-radius); padding: 20px; margin-bottom: 24px;">${rewardBox}</div>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <a href="${PROXY_BASE}/account/submission/${mine.id}?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--primary">View my post</a>
          <a href="https://${shop.shopDomain}/" class="ugme-btn ugme-btn--outline">Back to store</a>
        </div>
      </div>
    `;
    const html = proxyLayout({ title: "You're on the wall!", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const alreadyShared = url?.searchParams.get("already") === "1";

  const body = `
    <div style="text-align: center; padding: 24px 0;">
      <div style="width: 64px; height: 64px; border-radius: 50%; background: #ecfdf5; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 28px;">
        ✓
      </div>
      <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">${alreadyShared ? "You've already shared to this wall" : "Thanks for sharing!"}</h1>
      <p style="color: var(--ugme-muted); font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
        Your ${mediaWord} is in for review. You'll appear on the ${escapeHtml(brandName)} Social Wall once it's approved.
      </p>

      <div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 20px; margin-bottom: 24px; text-align: left;">
        <div class="ugme-section-label">What happens next</div>
        <div style="display: flex; flex-direction: column; gap: 12px; font-size: 14px; line-height: 1.5;">
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--ugme-accent); color: var(--ugme-accent-fg); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">1</div>
            <span>${escapeHtml(brandName)} reviews your post, usually within 3–5 business days.</span>
          </div>
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--ugme-border); color: var(--ugme-fg); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">2</div>
            <span>${campaign && hasReward(campaign) ? `If approved, you're featured on the wall and we email you your reward: <strong>${escapeHtml(reward)}</strong>.` : `If approved, you're featured on the wall with a Verified buyer badge, and we'll email you.`}</span>
          </div>
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--ugme-border); color: var(--ugme-fg); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">3</div>
            <span>Track status anytime in <a href="${PROXY_BASE}/account?shop=${shop.shopDomain}" style="color: var(--ugme-accent); text-decoration: underline;">My posts</a>.</span>
          </div>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <a href="${PROXY_BASE}/account?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--primary">My posts</a>
        <a href="https://${shop.shopDomain}/" class="ugme-btn ugme-btn--outline">Back to store</a>
      </div>
    </div>
  `;

  const html = proxyLayout({ title: "Thanks for sharing!", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── C11: My Submissions / Account ───────────────────────────────

async function handleAccount(shop: ShopInfo, brandName: string, loggedInCustomerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: loggedInCustomerId },
  });

  if (!customer) {
    // No submissions yet — show empty state
    const body = `
      <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">My posts</h1>
      <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 32px;">Track your posts and rewards.</p>

      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">📹</div>
        <h2 style="font-size: 18px; margin-bottom: 8px;">No posts yet</h2>
        <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">Bought something you love? Share a video on ${escapeHtml(brandName)}'s Social Wall.</p>
        <a href="https://${shop.shopDomain}/" class="ugme-btn ugme-btn--primary">Back to store</a>
      </div>
    `;
    const html = proxyLayout({ title: "My posts", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Get submissions with campaign info
  const submissions = await prisma.submission.findMany({
    where: { customerId: customer.id },
    select: {
      id: true,
      status: true,
      contentType: true,
      thumbnailUrl: true,
      createdAt: true,
      products: true,
      campaign: {
        select: {
          id: true,
          title: true,
          rewardCycles: true, rewardFrequency: true,
          discountType: true,
          discountValue: true,
          rewardType: true,
          discountCodeAmount: true,
          discountCodeType: true,
          discountCodeExpiryDays: true,
          discountCodeMinOrder: true,
      storeCreditAmount: true,
      storeCreditExpiryDays: true,
      productScope: true,
      products: true,
          productImageUrl: true,
        },
      },
      reward: {
        select: {
          status: true,
          cycles: true,
          appliedAt: true,
          rewardType: true,
          discountCode: true,
          storeCreditAmount: true,
          expiresAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get upcoming rewards (approved but not yet applied)
  const upcomingRewards = submissions.filter(
    (s) => s.status === "APPROVED" && hasReward(s.campaign) && s.reward?.status !== "APPLIED",
  );

  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string; label: string }> = {
      PENDING: { bg: "#fffbeb", color: "#92400e", label: "In review" },
      APPROVED: { bg: "#ecfdf5", color: "#065f46", label: "Approved" },
      REJECTED: { bg: "#fef2f2", color: "#991b1b", label: "Not approved" },
      FLAGGED: { bg: "#fef2f2", color: "#991b1b", label: "Flagged" },
    };
    const s = map[status] || map.PENDING;
    return `<span style="display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; background: ${s.bg}; color: ${s.color};">${s.label}</span>`;
  };

  const submissionCards = submissions
    .map((s) => {
      const reward = rewardText(s.campaign);
      const bought = parseProducts(s.products);
      const image = bought[0]?.imageUrl || s.campaign.productImageUrl;
      const heading = bought.length ? bought.map((p) => p.title).join(", ") : `${brandName} Social Wall`;
      const approvedLine = !hasReward(s.campaign)
        ? "Featured on the wall"
        : s.reward?.status === "APPLIED"
          ? s.reward.rewardType === "DISCOUNT_CODE" && s.reward.discountCode
            ? `${escapeHtml(reward)} — your code: <strong style="font-family: ui-monospace, Menlo, monospace;">${escapeHtml(s.reward.discountCode)}</strong>`
            : s.reward.rewardType === "STORE_CREDIT"
              ? `${escapeHtml(reward)} added to your account`
              : `${escapeHtml(reward)} — applied`
          : `${escapeHtml(reward)} — on its way`;
      const date = new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `
      <a href="${PROXY_BASE}/account/submission/${s.id}?shop=${shop.shopDomain}" style="text-decoration: none; color: inherit; display: block; border: 1px solid var(--ugme-border); border-radius: var(--ugme-radius); padding: 16px; display: flex; gap: 12px; align-items: flex-start; transition: box-shadow 0.15s ease;" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'" onmouseout="this.style.boxShadow='none'">
        ${
          image
            ? `<img src="${escapeHtml(image)}" alt="" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #f3f3f3; flex-shrink: 0;" />`
            : `<div style="width: 48px; height: 48px; border-radius: 8px; background: var(--ugme-surface); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">📹</div>`
        }
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 15px; margin-bottom: 4px;">${escapeHtml(heading)}</div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;">
            ${statusBadge(s.status)}
            <span style="font-size: 12px; color: var(--ugme-muted);">${date}</span>
          </div>
          ${s.status === "APPROVED" ? `<div style="font-size: 13px; color: var(--ugme-success);">${approvedLine}</div>` : ""}
        </div>
        <span style="color: var(--ugme-muted); font-size: 18px; align-self: center; flex-shrink: 0;">›</span>
      </a>
    `;
    })
    .join("");

  const upcomingHtml =
    upcomingRewards.length > 0
      ? `
    <div class="ugme-section-label" style="margin-top: 32px;">Rewards on the way</div>
    <div style="background: #ecfdf5; border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 24px;">
      ${upcomingRewards
        .map(
          (s) => `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px;">
          <span>${escapeHtml(parseProducts(s.products)[0]?.title || "Your post")}</span>
          <strong style="color: #065f46;">${escapeHtml(rewardText(s.campaign))}</strong>
        </div>
      `,
        )
        .join("")}
    </div>
  `
      : "";

  const body = `
    <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">My posts</h1>
    <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">
      ${submissions.length} post${submissions.length !== 1 ? "s" : ""} shared with ${escapeHtml(brandName)}
    </p>

    ${upcomingHtml}

    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${submissionCards}
    </div>

    <div style="margin-top: 32px;">
      <a href="https://${shop.shopDomain}/" class="ugme-btn ugme-btn--outline">Back to store</a>
    </div>
  `;

  const html = proxyLayout({ title: "My posts", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}


// ── Submission Detail View ─────────────────────────────────────

async function handleSubmissionDetail(submissionId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: loggedInCustomerId },
  });

  if (!customer) {
    return loginRedirect(shop.shopDomain, `${PROXY_BASE}/account/submission/${submissionId}`);
  }

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      status: true,
      contentType: true,
      contentUrl: true,
      thumbnailUrl: true,
      description: true,
      createdAt: true,
      rejectionReason: true,
      reviewNote: true,
      reviewedAt: true,
      products: true,
      customerId: true,
      campaign: {
        select: {
          id: true,
          title: true,
          moment: true,
          rewardCycles: true, rewardFrequency: true,
          discountType: true,
          discountValue: true,
          rewardType: true,
          discountCodeAmount: true,
          discountCodeType: true,
          discountCodeExpiryDays: true,
          discountCodeMinOrder: true,
      storeCreditAmount: true,
      storeCreditExpiryDays: true,
      productScope: true,
      products: true,
          productTitle: true,
          productImageUrl: true,
        },
      },
      reward: {
        select: {
          status: true,
          cycles: true,
          appliedAt: true,
          rewardType: true,
          discountCode: true,
          expiresAt: true,
        },
      },
    },
  });

  if (!submission || submission.customerId !== customer.id) {
    const body = `
      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
        <h1 style="font-size: 20px; margin-bottom: 8px;">Post not found</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px;">This post doesn't exist or doesn't belong to you.</p>
        <a href="${PROXY_BASE}/account?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">My posts</a>
      </div>
    `;
    const html = proxyLayout({ title: "Not Found", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const reward = rewardText(submission.campaign);
  const date = new Date(submission.createdAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const statusMap: Record<string, { bg: string; color: string; label: string; icon: string }> = {
    PENDING: { bg: "#fffbeb", color: "#92400e", label: "In review", icon: "⏳" },
    APPROVED: { bg: "#ecfdf5", color: "#065f46", label: "Approved", icon: "✓" },
    REJECTED: { bg: "#fef2f2", color: "#991b1b", label: "Not approved", icon: "✕" },
    FLAGGED: { bg: "#fef2f2", color: "#991b1b", label: "Flagged", icon: "⚠" },
  };
  const st = statusMap[submission.status] || statusMap.PENDING;

  const isVideo = submission.contentType === "VIDEO";
  const mediaWord = isVideo ? "video" : "photo";

  // Resolve R2 URLs to presigned download URLs for display
  let displayUrl = submission.contentUrl;
  const r2Key = extractKeyFromContentUrl(submission.contentUrl);
  if (r2Key && r2Key !== "pending") {
    try {
      displayUrl = await getPresignedDownloadUrl(r2Key);
    } catch (err) {
      console.error("[UGME] R2 presign error:", err);
    }
  }

  // Media preview — show content if URL is not a placeholder
  const isPlaceholder = submission.contentUrl.includes("placeholder.ugme.app") || submission.contentUrl === "r2://pending";
  const mediaHtml = isPlaceholder
    ? `<div style="width: 100%; aspect-ratio: 16/9; background: var(--ugme-surface); border-radius: var(--ugme-radius); display: flex; align-items: center; justify-content: center; margin-bottom: 20px;">
        <div style="text-align: center; color: var(--ugme-muted);">
          <div style="font-size: 36px; margin-bottom: 8px;">${isVideo ? "🎬" : "📷"}</div>
          <div style="font-size: 14px;">Your ${mediaWord} is being processed</div>
        </div>
      </div>`
    : isVideo
      ? `<video src="${escapeHtml(displayUrl)}" style="width: 100%; max-height: 400px; object-fit: contain; background: #000; border-radius: var(--ugme-radius); margin-bottom: 20px;" controls></video>`
      : `<img src="${escapeHtml(displayUrl)}" alt="Submission" style="width: 100%; max-height: 400px; object-fit: contain; border-radius: var(--ugme-radius); margin-bottom: 20px; background: var(--ugme-surface);" />`;

  // Rejection reason
  const rejectionHtml = submission.status === "REJECTED" && submission.rejectionReason
    ? `<div style="background: #fef2f2; border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;">
        <div class="ugme-section-label" style="color: #991b1b;">Reason</div>
        <p style="font-size: 14px; color: #991b1b; line-height: 1.5; margin: 0;">${escapeHtml(submission.rejectionReason)}</p>
      </div>`
    : "";

  // Review note
  const reviewNoteHtml = submission.reviewNote
    ? `<div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;">
        <div class="ugme-section-label">Reviewer note</div>
        <p style="font-size: 14px; line-height: 1.5; margin: 0;">${escapeHtml(submission.reviewNote)}</p>
      </div>`
    : "";

  // Reward info for approved
  let rewardHtml = "";
  if (submission.status === "APPROVED") {
    const r = submission.reward;
    const fmtDate = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    let appliedLine: string;
    if (r?.status === "APPLIED" && r.rewardType === "DISCOUNT_CODE" && r.discountCode) {
      appliedLine =
        '<div style="margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">' +
        '<code style="font-family: ui-monospace, Menlo, monospace; font-size: 16px; font-weight: 700; letter-spacing: 0.04em; background: #fff; border: 1px dashed #059669; color: #065f46; padding: 8px 12px; border-radius: 8px;">' + escapeHtml(r.discountCode) + '</code>' +
        '</div>' +
        '<p style="font-size: 13px; color: #065f46; margin: 8px 0 0 0;">Use this code at checkout. Single use' +
        (r.expiresAt ? ', expires ' + fmtDate(r.expiresAt) : '') + '.</p>';
    } else if (!hasReward(submission.campaign)) {
      appliedLine = '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Your post is live on the Social Wall with a Verified buyer badge.</p>';
    } else if (r?.status === "APPLIED" && r.rewardType === "STORE_CREDIT") {
      appliedLine = '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Added to your account' + (r.appliedAt ? ' on ' + fmtDate(r.appliedAt) : '') + '. Sign in when you shop and apply it at checkout' + (r.expiresAt ? ' (expires ' + fmtDate(r.expiresAt) + ')' : '') + '.</p>';
    } else if (r?.status === "APPLIED" && r.appliedAt) {
      appliedLine = '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Applied on ' + fmtDate(r.appliedAt) + '</p>';
    } else {
      appliedLine = '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Your reward will be delivered soon</p>';
    }
    rewardHtml = `<div style="background: #ecfdf5; border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;">
        <div class="ugme-section-label" style="color: #065f46;">${hasReward(submission.campaign) ? "Reward" : "You're on the wall"}</div>
        <p style="font-size: 15px; font-weight: 600; color: #065f46; margin: 0;">${escapeHtml(reward)}</p>
        ${appliedLine}
      </div>`;
  }

  // Delete button — only for PENDING submissions
  const deleteHtml = submission.status === "PENDING"
    ? `<hr class="ugme-divider" />
      <form method="POST" action="${PROXY_BASE}/account/submission/${submission.id}/delete?shop=${shop.shopDomain}" onsubmit="return confirm('Delete this post? This cannot be undone.');">
        <button type="submit" class="ugme-btn" style="background: #fef2f2; color: #991b1b; border: 1px solid #fecaca;">
          Delete post
        </button>
      </form>`
    : "";

  const body = `
    <a href="${PROXY_BASE}/account?shop=${shop.shopDomain}" style="display: inline-flex; align-items: center; gap: 4px; color: var(--ugme-muted); text-decoration: none; font-size: 14px; margin-bottom: 16px;">
      ← My posts
    </a>

    ${mediaHtml}

    <!-- Status -->
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
      <div style="width: 36px; height: 36px; border-radius: 50%; background: ${st.bg}; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0;">${st.icon}</div>
      <div>
        <div style="font-weight: 600; font-size: 16px;">${st.label}</div>
        <div style="font-size: 13px; color: var(--ugme-muted);">Submitted ${date}</div>
      </div>
    </div>

    ${rejectionHtml}
    ${reviewNoteHtml}
    ${rewardHtml}

    <!-- Product info -->
    <div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;">
      <div class="ugme-section-label">Product</div>
      <div style="display: flex; align-items: center; gap: 12px;">
        ${(parseProducts(submission.products)[0]?.imageUrl || submission.campaign.productImageUrl)
          ? '<img src="' + escapeHtml(parseProducts(submission.products)[0]?.imageUrl || submission.campaign.productImageUrl || "") + '" alt="" style="width: 40px; height: 40px; border-radius: 8px; object-fit: cover; background: #f3f3f3;" />'
          : ""
        }
        <div>
          <div style="font-weight: 600; font-size: 14px;">${escapeHtml(parseProducts(submission.products).map((p) => p.title).join(", ") || `${brandName} Social Wall`)}</div>
          <div style="font-size: 13px; color: var(--ugme-muted);">Reward: ${escapeHtml(reward)}</div>
        </div>
      </div>
    </div>

    ${submission.description
      ? '<div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;"><div class="ugme-section-label">Your message</div><p style="font-size: 14px; line-height: 1.5; margin: 0;">' + escapeHtml(submission.description) + '</p></div>'
      : ""
    }

    ${deleteHtml}
  `;

  const html = proxyLayout({ title: "Submission", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── Delete Submission ──────────────────────────────────────────

async function handleDeleteSubmission(submissionId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: loggedInCustomerId },
  });

  if (!customer) {
    return new Response("Login required", { status: 401 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { id: true, customerId: true, status: true, campaignId: true, contentUrl: true },
  });

  if (!submission || submission.customerId !== customer.id) {
    return new Response("Not found", { status: 404 });
  }

  // Only allow deleting PENDING submissions
  if (submission.status !== "PENDING") {
    // Redirect back to detail with an error indicator
    const body = `
      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
        <h1 style="font-size: 20px; margin-bottom: 8px;">Can't delete</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px;">Only pending submissions can be deleted. This submission has already been reviewed.</p>
        <a href="${PROXY_BASE}/account?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">My posts</a>
      </div>
    `;
    const html = proxyLayout({ title: "Can't Delete", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Delete the file from R2
  const r2Key = extractKeyFromContentUrl(submission.contentUrl);
  if (r2Key) {
    try {
      await deleteObject(r2Key);
    } catch (err) {
      console.error("[UGME] R2 delete error:", err);
      // Non-fatal — continue with DB deletion
    }
  }

  // Delete the submission
  await prisma.submission.delete({
    where: { id: submissionId },
  });

  // Redirect back to account page using client-side redirect (proxy doesn't forward 302)
  const redirectUrl = `${PROXY_BASE}/account?shop=${shop.shopDomain}&deleted=1`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0;url=${redirectUrl}" />
  <script>window.location.href="${redirectUrl}";</script>
</head>
<body></body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
