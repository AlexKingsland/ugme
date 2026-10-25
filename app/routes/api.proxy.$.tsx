import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { verifyProxySignature } from "../utils/proxy-auth.server";
import { proxyLayout } from "../utils/proxy-layout.server";
import crypto from "crypto";
import { buildObjectKey, uploadToR2, deleteObject, extractKeyFromContentUrl, getPresignedDownloadUrl, getPresignedUploadUrl, headObject, posterKeyFor, createMultipartUpload, getPresignedPartUrl, completeMultipartUpload, abortMultipartUpload } from "../utils/r2.server";
import { verifyActiveSubscriber, getRechargeCustomer, getActiveSubscriptionsForProduct, applyRewardToNextCharge } from "../utils/recharge.server";
import { checkPlanGates, type PlanTierKey } from "../utils/plans.server";
import { checkRewardGating } from "../utils/reward-gating.server";
import { canvasJsonResponse } from "../utils/canvas.server";

/**
 * App Proxy catch-all route.
 * Shopify forwards requests from {store}/apps/ugme/* to this handler.
 *
 * Routes:
 *   /apps/ugme                          → campaign library (C2.5)
 *   /apps/ugme/campaign/:id             → campaign detail (C3)
 *   /apps/ugme/campaign/:id/submit      → upload & submit (C9) — requires auth
 *   /apps/ugme/campaign/:id/submitted   → confirmation (C10) — requires auth
 *   POST /apps/ugme/campaign/:id/upload-url → presigned R2 PUT for direct browser upload (JSON)
 *   POST /apps/ugme/campaign/:id/complete   → confirm upload landed + create submission (JSON)
 *   /apps/ugme/account                  → my submissions (C11) — requires auth
 *   /apps/ugme/canvas?campaigns=a,b     → JSON media for the Social Wall theme block
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

function rewardText(campaign: {
  rewardType?: string;
  discountType: string;
  discountValue: number;
  rewardCycles: number;
  rewardFrequency: string;
  discountCodeAmount?: number | null;
  discountCodeType?: string | null;
  discountCodeExpiryDays?: number | null;
}): string {
  // Discount code reward type
  if (campaign.rewardType === "DISCOUNT_CODE" && campaign.discountCodeAmount) {
    const discountText = campaign.discountCodeType === "PERCENTAGE"
      ? `${campaign.discountCodeAmount}% off`
      : `$${campaign.discountCodeAmount} off`;
    const expiryText = campaign.discountCodeExpiryDays
      ? ` (expires in ${campaign.discountCodeExpiryDays} days)`
      : "";
    return `${discountText} discount code${expiryText}`;
  }
  // Subscription discount reward type (legacy default)
  if (campaign.discountType === "FREE")
    return `${campaign.rewardCycles} month${campaign.rewardCycles !== 1 ? "s" : ""} free`;
  if (campaign.discountType === "FIXED_AMOUNT")
    return `$${campaign.discountValue} off × ${campaign.rewardCycles}mo`;
  return `${campaign.discountValue}% off × ${campaign.rewardCycles}mo`;
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
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `/apps/ugme/campaign/${submittedMatch[1]}/submitted`);
    return handleSubmitted(submittedMatch[1], shop, brandName, loggedInCustomerId);
  }

  // Route: /campaign/:id/submit
  const submitMatch = proxyPath.match(/^campaign\/([^/]+)\/submit$/);
  if (submitMatch) {
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `/apps/ugme/campaign/${submitMatch[1]}/submit`);
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
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, `/apps/ugme/account/submission/${submissionDetailMatch[1]}`);
    return handleSubmissionDetail(submissionDetailMatch[1], shop, brandName, loggedInCustomerId);
  }

  // Route: /account
  if (proxyPath === "account") {
    if (!loggedInCustomerId) return loginRedirect(shop.shopDomain, "/apps/ugme/account");
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
    where: { shopId: shop.id, status: "ACTIVE" },
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
    <a href="/apps/ugme/campaign/${c.id}?shop=${shop.shopDomain}" style="text-decoration: none; color: inherit; display: block; border: 1px solid var(--ugme-border); border-radius: var(--ugme-radius); overflow: hidden; transition: box-shadow 0.15s ease;" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'" onmouseout="this.style.boxShadow='none'">
      <div style="padding: 16px;">
        <div style="display: flex; align-items: flex-start; gap: 12px;">
          ${
            c.productImageUrl
              ? `<img src="${escapeHtml(c.productImageUrl)}" alt="" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #f3f3f3;" />`
              : ""
          }
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 15px; margin-bottom: 2px;">${escapeHtml(c.title)}</div>
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
    <div class="ugme-section-label">FROM ${escapeHtml(brandName).toUpperCase()}</div>
    <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px;">Real content, real discount.</h1>
    <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">
      ${campaigns.length} ask${campaigns.length !== 1 ? "s" : ""} live right now. Pick one — approved videos
      earn rewards for approved content.
    </p>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${campaignCards || '<p style="color: var(--ugme-muted);">No campaigns available right now.</p>'}
    </div>
    <p style="font-size: 12px; color: var(--ugme-muted); margin-top: 24px;">
      One submission per ask. Approved content earns you the listed reward.
    </p>
  `;

  const html = proxyLayout({ title: "Campaigns", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
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
        <h1 style="font-size: 20px; margin-bottom: 8px;">Campaign not found</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px;">This campaign may have ended or doesn't exist.</p>
        <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Browse campaigns</a>
      </div>
    `;
    const html = proxyLayout({ title: "Not Found", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // ── Product-specific subscription verification (Recharge) ──
  if (campaign.rewardType !== "DISCOUNT_CODE" && shop.providerConnected && shop.subscriptionProvider === "RECHARGE" && campaign.productId && loggedInCustomerId) {
    try {
      const rechargeCustomer = await getRechargeCustomer(
        loggedInCustomerId,
        shop.providerApiKey || undefined
      );
      if (!rechargeCustomer) {
        const body = `
          <div style="text-align: center; padding: 40px 0;">
            <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
            <h1 style="font-size: 20px; margin-bottom: 8px;">Subscribers only</h1>
            <p style="color: var(--ugme-muted); margin-bottom: 24px;">You need an active subscription to submit content and earn rewards.</p>
            <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Back to campaigns</a>
          </div>
        `;
        const html = proxyLayout({ title: "Subscribers Only", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const matchingSubs = await getActiveSubscriptionsForProduct(
        rechargeCustomer.id,
        campaign.productId,
        shop.providerApiKey || undefined
      );
      if (matchingSubs.length === 0) {
        const body = `
          <div style="text-align: center; padding: 40px 0;">
            <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
            <h1 style="font-size: 20px; margin-bottom: 8px;">No matching subscription</h1>
            <p style="color: var(--ugme-muted); margin-bottom: 24px;">Rewards for this campaign are only available to subscribers of <strong>${escapeHtml(campaign.productTitle || "this product")}</strong>.</p>
            <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Back to campaigns</a>
          </div>
        `;
        const html = proxyLayout({ title: "No Matching Subscription", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    } catch (err) {
      console.error("[UGME] Recharge product subscription check failed:", err);
      // Fail open
    }
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

  const slotsRemaining = campaign.maxSubmissions ? Math.max(0, campaign.maxSubmissions - campaign._count.submissions) : null;

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
      ${slotsRemaining !== null ? `<span style="font-weight: 600;">${slotsRemaining} slot${slotsRemaining !== 1 ? "s" : ""} left</span>` : ""}
      ${deadlineHtml ? `<span style="color: var(--ugme-muted);">${deadlineHtml}</span>` : ""}
    </div>
  `
      : "";

  const body = `
    <div class="ugme-section-label">FROM ${escapeHtml(brandName).toUpperCase()}</div>
    <h1 style="font-size: 24px; font-weight: 700; line-height: 1.3; margin-bottom: 12px;">${escapeHtml(campaign.title)}</h1>
    <div style="margin-bottom: 20px;">
      <span class="ugme-badge ugme-badge--reward">${escapeHtml(reward)}</span>
    </div>

    <div class="ugme-section-label">What we're looking for</div>
    <p style="font-size: 15px; margin-bottom: 24px; line-height: 1.6;">${escapeHtml(campaign.moment)}</p>

    ${techSpecsHtml}
    ${requirementsHtml}
    ${statsHtml}

    <a href="/apps/ugme/campaign/${campaign.id}/submit?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--primary">
      Submit your ${campaign.contentType === "VIDEO" ? "video" : "photo"}
    </a>

    <p style="font-size: 12px; color: var(--ugme-muted); margin-top: 16px; line-height: 1.5;">
      Approved ${campaign.contentType === "VIDEO" ? "videos" : "photos"} ${reward.includes("free") ? `earn ${reward} on` : `take ${reward}`} your next subscription charge automatically.
      You'll agree to terms and submit next.
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
      headers: { Location: `/apps/ugme?shop=${shop.shopDomain}` },
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
      headers: { Location: `/apps/ugme/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` },
    });
  }

  // Check slots
  if (campaign.maxSubmissions) {
    const remaining = campaign.maxSubmissions - campaign._count.submissions;
    if (remaining <= 0) {
      const body = `
        <div style="text-align: center; padding: 40px 0;">
          <div style="font-size: 48px; margin-bottom: 16px;">😔</div>
          <h1 style="font-size: 20px; margin-bottom: 8px;">All slots filled</h1>
          <p style="color: var(--ugme-muted); margin-bottom: 24px;">This campaign has reached its submission limit.</p>
          <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Browse other campaigns</a>
        </div>
      `;
      const html = proxyLayout({ title: "Slots Full", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  }

  // ── Product-specific subscription verification (Recharge) ──
  let matchingSubscriptionId: string | null = null;

  if (campaign.rewardType !== "DISCOUNT_CODE" && shop.providerConnected && shop.subscriptionProvider === "RECHARGE" && campaign.productId && loggedInCustomerId) {
    try {
      const rechargeCustomer = await getRechargeCustomer(
        customer.shopifyCustomerId || loggedInCustomerId,
        shop.providerApiKey || undefined
      );
      if (!rechargeCustomer) {
        const body = `
          <div style="text-align: center; padding: 40px 0;">
            <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
            <h1 style="font-size: 20px; margin-bottom: 8px;">Subscribers only</h1>
            <p style="color: var(--ugme-muted); margin-bottom: 24px;">You need an active subscription to submit content and earn rewards.</p>
            <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Back to campaigns</a>
          </div>
        `;
        const html = proxyLayout({ title: "Subscribers Only", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const matchingSubs = await getActiveSubscriptionsForProduct(
        rechargeCustomer.id,
        campaign.productId,
        shop.providerApiKey || undefined
      );

      if (matchingSubs.length === 0) {
        const body = `
          <div style="text-align: center; padding: 40px 0;">
            <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
            <h1 style="font-size: 20px; margin-bottom: 8px;">No matching subscription</h1>
            <p style="color: var(--ugme-muted); margin-bottom: 24px;">Rewards for this campaign are only available to subscribers of <strong>${escapeHtml(campaign.productTitle || "this product")}</strong>.</p>
            <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">Back to campaigns</a>
          </div>
        `;
        const html = proxyLayout({ title: "No Matching Subscription", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // Auto-select if only one, otherwise we'll show a picker
      matchingSubscriptionId = String(matchingSubs[0].id);
    } catch (err) {
      console.error("[UGME] Recharge product subscription check failed:", err);
      // Fail open
    }
  }

  // ── Reward gating warning for single-discount providers (e.g. Recharge) ──
  let rewardWarningHtml = "";
  if (shop.providerConnected) {
    try {
      const gating = await checkRewardGating({
        customerId: customer.id,
        shopId: shop.id,
        subscriptionProvider: shop.subscriptionProvider as any,
      });
      if (gating.hasActiveReward && gating.message) {
        rewardWarningHtml = `
          <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: var(--ugme-radius); padding: 14px 16px; margin-bottom: 20px;">
            <div style="font-weight: 600; font-size: 14px; color: #92400e; margin-bottom: 4px;">\u26a0\ufe0f Heads up \u2014 you have an active reward</div>
            <div style="font-size: 13px; color: #78350f; line-height: 1.5;">${escapeHtml(gating.message)}</div>
          </div>
        `;
      }
    } catch (err) {
      console.error("[UGME] Reward gating check failed:", err);
      // Fail open — don't block submission if gating check fails
    }
  }

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
      plan_limit: "Submission limit reached. The store\u2019s current plan cannot accept more submissions right now.",
    };
    const msg = errorMsgs[errorParam] || "Something went wrong. Please try again.";
    errorBannerHtml = '<div style="background: #fef2f2; color: #991b1b; padding: 14px 16px; border-radius: var(--ugme-radius); margin-bottom: 20px; font-size: 14px;">' + msg + '</div>';
  }

  const body = `
    <a href="/apps/ugme/campaign/${campaign.id}?shop=${shop.shopDomain}" style="display: inline-flex; align-items: center; gap: 4px; color: var(--ugme-muted); text-decoration: none; font-size: 14px; margin-bottom: 16px;">
      ← Back to brief
    </a>

    <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 4px;">Submit your ${mediaWord}</h1>
    <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">
      ${escapeHtml(campaign.title)} · <span class="ugme-badge ugme-badge--reward" style="font-size: 12px; padding: 2px 8px;">${escapeHtml(reward)}</span>
    </p>

    ${errorBannerHtml}
    ${rewardWarningHtml}
    <form id="submitForm" method="POST" action="/apps/ugme/campaign/${campaign.id}/submit?shop=${shop.shopDomain}" enctype="multipart/form-data">

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

      <!-- Optional message -->
      <div class="ugme-section-label">Message (optional)</div>
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
            <span>If approved, your reward (${escapeHtml(reward)}) will be delivered to you.</span>
          </li>
          <li style="display: flex; gap: 8px;">
            <span style="flex-shrink: 0;">✓</span>
            <span>Submissions are typically reviewed within 3–5 business days.</span>
          </li>
        </ul>
        <label style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; cursor: pointer;">
          <input type="checkbox" id="termsCheckbox" name="terms" required style="margin-top: 2px; accent-color: var(--ugme-accent); width: 18px; height: 18px; flex-shrink: 0;" />
          <span>I agree to these terms and grant usage rights for my content.</span>
        </label>
      </div>

      <button type="submit" id="submitBtn" class="ugme-btn ugme-btn--primary" disabled style="opacity: 0.5; cursor: not-allowed;">
        Submit ${mediaWord}
      </button>

      <p style="font-size: 12px; color: var(--ugme-muted); text-align: center; margin-top: 12px;">
        One submission per campaign. You can't edit after submitting.
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
            subscriptionId: fields.get('subscriptionId') || '',
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
    select: { id: true, title: true, shopId: true, status: true, contentType: true, productId: true, rewardType: true },
  });

  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    return new Response(null, {
      status: 302,
      headers: { Location: `/apps/ugme?shop=${shop.shopDomain}` },
    });
  }

  const customer = await findOrCreateCustomer(shop.id, loggedInCustomerId, shop.accessToken, shop.shopDomain);

  // ── Product-specific subscription verification (Recharge) ──
  if (campaign.rewardType !== "DISCOUNT_CODE" && shop.providerConnected && shop.subscriptionProvider === "RECHARGE" && campaign.productId && loggedInCustomerId) {
    try {
      const rechargeCustomer = await getRechargeCustomer(
        loggedInCustomerId,
        shop.providerApiKey || undefined
      );
      if (!rechargeCustomer) {
        return errorRedirect(shop.shopDomain, campaignId, "no_subscription");
      }

      const matchingSubs = await getActiveSubscriptionsForProduct(
        rechargeCustomer.id,
        campaign.productId,
        shop.providerApiKey || undefined
      );
      if (matchingSubs.length === 0) {
        return errorRedirect(shop.shopDomain, campaignId, "no_subscription");
      }
    } catch (err) {
      console.error("[UGME] Recharge product subscription check on submit failed:", err);
      // Fail open
    }
  }

  // Check duplicate
  const existing = await prisma.submission.findFirst({
    where: { campaignId, customerId: customer.id, status: { not: "REJECTED" } },
  });
  if (existing) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/apps/ugme/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` },
    });
  }

  // Parse the multipart form data
  let description = "";
  let subscriptionId = "";
  let file: File | null = null;
  try {
    const formData = await request.formData();
    description = (formData.get("message") as string) || "";
    subscriptionId = (formData.get("subscriptionId") as string) || "";
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
      subscriptionId: subscriptionId || null,
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
    headers: { Location: `/apps/ugme/campaign/${campaignId}/submitted?shop=${shop.shopDomain}` },
  });
}

// ── Direct browser → R2 upload ──────────────────────────────────
// The browser PUTs the file straight to R2 (with a real progress bar) instead of
// streaming it through Shopify's app proxy → tunnel → this server → R2. The
// legacy multipart /submit route above stays as an automatic fallback.

const UPLOAD_ERRORS: Record<string, string> = {
  no_file: "Please select a file to upload.",
  too_large: "File is too large. Maximum size is 1 GB.",
  wrong_type: "That file type isn't accepted for this campaign.",
  upload_failed: "Upload failed. Please try again.",
  plan_limit: "Submission limit reached. The store’s current plan cannot accept more submissions right now.",
  no_subscription: "You need an active subscription to this product to submit.",
  closed: "This campaign is no longer accepting submissions.",
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
    select: { id: true, title: true, shopId: true, status: true, contentType: true, productId: true, rewardType: true },
  });
  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    return { ok: false as const, response: uploadError("closed", 409) };
  }

  const customer = await findOrCreateCustomer(shop.id, loggedInCustomerId, shop.accessToken, shop.shopDomain);

  if (campaign.rewardType !== "DISCOUNT_CODE" && shop.providerConnected && shop.subscriptionProvider === "RECHARGE" && campaign.productId) {
    try {
      const rechargeCustomer = await getRechargeCustomer(loggedInCustomerId, shop.providerApiKey || undefined);
      if (!rechargeCustomer) return { ok: false as const, response: uploadError("no_subscription", 403) };
      const subs = await getActiveSubscriptionsForProduct(rechargeCustomer.id, campaign.productId, shop.providerApiKey || undefined);
      if (subs.length === 0) return { ok: false as const, response: uploadError("no_subscription", 403) };
    } catch (err) {
      console.error("[UGME] Recharge check (direct upload) failed:", err);
      // Fail open, same as the multipart path
    }
  }

  const existing = await prisma.submission.findFirst({
    where: { campaignId, customerId: customer.id, status: { not: "REJECTED" } },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false as const,
      response: uploadJson({ redirect: `/apps/ugme/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` }, 409),
    };
  }

  return { ok: true as const, campaign, customer };
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
    subscriptionId?: string;
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
      subscriptionId: body.subscriptionId || null,
      rightsAccepted: true,
    },
  });

  return uploadJson({ redirect: `/apps/ugme/campaign/${campaignId}/submitted?shop=${shop.shopDomain}` });
}

function errorRedirect(shopDomain: string, campaignId: string, reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `/apps/ugme/campaign/${campaignId}/submit?shop=${shopDomain}&error=${reason}` },
  });
}

// ── C10: Submitted Confirmation ─────────────────────────────────

async function handleSubmitted(campaignId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string) {
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
      contentType: true,
      shopId: true,
    },
  });

  const reward = campaign ? rewardText(campaign) : "your reward";
  const mediaWord = campaign?.contentType === "VIDEO" ? "video" : "photo";

  const body = `
    <div style="text-align: center; padding: 24px 0;">
      <div style="width: 64px; height: 64px; border-radius: 50%; background: #ecfdf5; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 28px;">
        ✓
      </div>
      <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">Submitted!</h1>
      <p style="color: var(--ugme-muted); font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
        Your ${mediaWord} for <strong>${escapeHtml(campaign?.title || "this campaign")}</strong> is in for review.
      </p>

      <div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 20px; margin-bottom: 24px; text-align: left;">
        <div class="ugme-section-label">What happens next</div>
        <div style="display: flex; flex-direction: column; gap: 12px; font-size: 14px; line-height: 1.5;">
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--ugme-accent); color: var(--ugme-accent-fg); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">1</div>
            <span>We'll review your submission within 3–5 business days.</span>
          </div>
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--ugme-border); color: var(--ugme-fg); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">2</div>
            <span>If approved, your reward of <strong>${escapeHtml(reward)}</strong> will be delivered to you.</span>
          </div>
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--ugme-border); color: var(--ugme-fg); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;">3</div>
            <span>Track status anytime in <a href="/apps/ugme/account?shop=${shop.shopDomain}" style="color: var(--ugme-accent); text-decoration: underline;">My submissions</a>.</span>
          </div>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <a href="/apps/ugme/account?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--primary">My submissions</a>
        <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline">Browse other campaigns</a>
      </div>
    </div>
  `;

  const html = proxyLayout({ title: "Submitted!", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
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
      <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">My submissions</h1>
      <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 32px;">Track your submissions and upcoming discounts.</p>

      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">📹</div>
        <h2 style="font-size: 18px; margin-bottom: 8px;">No submissions yet</h2>
        <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">Submit your first video to earn discounts on your subscription.</p>
        <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--primary">Browse campaigns</a>
      </div>
    `;
    const html = proxyLayout({ title: "My Submissions", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
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
          productImageUrl: true,
        },
      },
      reward: {
        select: {
          status: true,
          cycles: true,
          appliedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get upcoming rewards (approved but not yet applied)
  const upcomingRewards = submissions.filter(
    (s) => s.status === "APPROVED" && s.reward && s.reward.status !== "APPLIED",
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
      const date = new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `
      <a href="/apps/ugme/account/submission/${s.id}?shop=${shop.shopDomain}" style="text-decoration: none; color: inherit; display: block; border: 1px solid var(--ugme-border); border-radius: var(--ugme-radius); padding: 16px; display: flex; gap: 12px; align-items: flex-start; transition: box-shadow 0.15s ease;" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'" onmouseout="this.style.boxShadow='none'">
        ${
          s.campaign.productImageUrl
            ? `<img src="${escapeHtml(s.campaign.productImageUrl)}" alt="" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #f3f3f3; flex-shrink: 0;" />`
            : `<div style="width: 48px; height: 48px; border-radius: 8px; background: var(--ugme-surface); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">📹</div>`
        }
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 15px; margin-bottom: 4px;">${escapeHtml(s.campaign.title)}</div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;">
            ${statusBadge(s.status)}
            <span style="font-size: 12px; color: var(--ugme-muted);">${date}</span>
          </div>
          ${s.status === "APPROVED" ? `<div style="font-size: 13px; color: var(--ugme-success);">${escapeHtml(reward)} — reward applied</div>` : ""}
        </div>
        <span style="color: var(--ugme-muted); font-size: 18px; align-self: center; flex-shrink: 0;">›</span>
      </a>
    `;
    })
    .join("");

  const upcomingHtml =
    upcomingRewards.length > 0
      ? `
    <div class="ugme-section-label" style="margin-top: 32px;">Upcoming discounts</div>
    <div style="background: #ecfdf5; border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 24px;">
      ${upcomingRewards
        .map(
          (s) => `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px;">
          <span>${escapeHtml(s.campaign.title)}</span>
          <strong style="color: #065f46;">${escapeHtml(rewardText(s.campaign))}</strong>
        </div>
      `,
        )
        .join("")}
    </div>
  `
      : "";

  const body = `
    <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">My submissions</h1>
    <p style="color: var(--ugme-muted); font-size: 14px; margin-bottom: 24px;">
      ${submissions.length} submission${submissions.length !== 1 ? "s" : ""} total
    </p>

    ${upcomingHtml}

    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${submissionCards}
    </div>

    <div style="margin-top: 32px;">
      <a href="/apps/ugme?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline">Browse campaigns</a>
    </div>
  `;

  const html = proxyLayout({ title: "My Submissions", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}


// ── Submission Detail View ─────────────────────────────────────

async function handleSubmissionDetail(submissionId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: loggedInCustomerId },
  });

  if (!customer) {
    return loginRedirect(shop.shopDomain, `/apps/ugme/account/submission/${submissionId}`);
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
          productTitle: true,
          productImageUrl: true,
        },
      },
      reward: {
        select: {
          status: true,
          cycles: true,
          appliedAt: true,
        },
      },
    },
  });

  if (!submission || submission.customerId !== customer.id) {
    const body = `
      <div style="text-align: center; padding: 40px 0;">
        <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
        <h1 style="font-size: 20px; margin-bottom: 8px;">Submission not found</h1>
        <p style="color: var(--ugme-muted); margin-bottom: 24px;">This submission doesn't exist or doesn't belong to you.</p>
        <a href="/apps/ugme/account?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">My submissions</a>
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
    const appliedLine = submission.reward?.appliedAt
      ? '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Applied on ' + new Date(submission.reward.appliedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + '</p>'
      : '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Your reward will be delivered soon</p>';
    rewardHtml = `<div style="background: #ecfdf5; border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;">
        <div class="ugme-section-label" style="color: #065f46;">Reward</div>
        <p style="font-size: 15px; font-weight: 600; color: #065f46; margin: 0;">${escapeHtml(reward)}</p>
        ${appliedLine}
      </div>`;
  }

  // Delete button — only for PENDING submissions
  const deleteHtml = submission.status === "PENDING"
    ? `<hr class="ugme-divider" />
      <form method="POST" action="/apps/ugme/account/submission/${submission.id}/delete?shop=${shop.shopDomain}" onsubmit="return confirm('Delete this submission? This cannot be undone.');">
        <button type="submit" class="ugme-btn" style="background: #fef2f2; color: #991b1b; border: 1px solid #fecaca;">
          Delete submission
        </button>
      </form>`
    : "";

  const body = `
    <a href="/apps/ugme/account?shop=${shop.shopDomain}" style="display: inline-flex; align-items: center; gap: 4px; color: var(--ugme-muted); text-decoration: none; font-size: 14px; margin-bottom: 16px;">
      ← My submissions
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

    <!-- Campaign info -->
    <div style="background: var(--ugme-surface); border-radius: var(--ugme-radius); padding: 16px; margin-bottom: 20px;">
      <div class="ugme-section-label">Campaign</div>
      <div style="display: flex; align-items: center; gap: 12px;">
        ${submission.campaign.productImageUrl
          ? '<img src="' + escapeHtml(submission.campaign.productImageUrl) + '" alt="" style="width: 40px; height: 40px; border-radius: 8px; object-fit: cover; background: #f3f3f3;" />'
          : ""
        }
        <div>
          <div style="font-weight: 600; font-size: 14px;">${escapeHtml(submission.campaign.title)}</div>
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
        <a href="/apps/ugme/account?shop=${shop.shopDomain}" class="ugme-btn ugme-btn--outline" style="display: inline-block; width: auto;">My submissions</a>
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
  const redirectUrl = `/apps/ugme/account?shop=${shop.shopDomain}&deleted=1`;
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
