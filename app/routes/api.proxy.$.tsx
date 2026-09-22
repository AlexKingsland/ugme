import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { verifyProxySignature } from "../utils/proxy-auth.server";
import { proxyLayout } from "../utils/proxy-layout.server";
import { buildObjectKey, uploadToR2, deleteObject, extractKeyFromContentUrl, getPresignedDownloadUrl } from "../utils/r2.server";

/**
 * App Proxy catch-all route.
 * Shopify forwards requests from {store}/apps/ugme/* to this handler.
 *
 * Routes:
 *   /apps/ugme                          → campaign library (C2.5)
 *   /apps/ugme/campaign/:id             → campaign detail (C3)
 *   /apps/ugme/campaign/:id/submit      → upload & submit (C9) — requires auth
 *   /apps/ugme/campaign/:id/submitted   → confirmation (C10) — requires auth
 *   /apps/ugme/account                  → my submissions (C11) — requires auth
 */

type ShopInfo = {
  id: string;
  shopDomain: string;
  brandName: string | null;
  logoUrl: string | null;
  accessToken: string;
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
  discountType: string;
  discountValue: number;
  rewardMonths: number;
}): string {
  if (campaign.discountType === "FREE")
    return `${campaign.rewardMonths} month${campaign.rewardMonths !== 1 ? "s" : ""} free`;
  if (campaign.discountType === "FIXED_AMOUNT")
    return `$${campaign.discountValue} off × ${campaign.rewardMonths}mo`;
  return `${campaign.discountValue}% off × ${campaign.rewardMonths}mo`;
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
    select: { id: true, shopDomain: true, brandName: true, logoUrl: true, accessToken: true },
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

  // POST /campaign/:id/submit — process the submission
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
      rewardMonths: true,
      discountType: true,
      discountValue: true,
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
      reduce your next subscription charge.
    </p>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${campaignCards || '<p style="color: var(--ugme-muted);">No campaigns available right now.</p>'}
    </div>
    <p style="font-size: 12px; color: var(--ugme-muted); margin-top: 24px;">
      One submission per ask. Approved videos discount your next charge automatically — no code, no wallet.
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
      rewardMonths: true,
      discountType: true,
      discountValue: true,
      maxSubmissions: true,
      endDate: true,
      status: true,
      shopId: true,
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
      rewardMonths: true,
      discountType: true,
      discountValue: true,
      maxSubmissions: true,
      status: true,
      shopId: true,
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
    where: { campaignId, customerId: customer.id },
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
      too_large: "File is too large. Maximum size is 100 MB.",
      upload_failed: "Upload failed. Please try again.",
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
    <form id="submitForm" method="POST" action="/apps/ugme/campaign/${campaign.id}/submit?shop=${shop.shopDomain}" enctype="multipart/form-data">

      <!-- File upload area -->
      <div id="uploadArea" style="border: 2px dashed var(--ugme-border); border-radius: var(--ugme-radius); padding: 40px 20px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; margin-bottom: 20px;" onclick="document.getElementById('fileInput').click()">
        <div id="uploadIcon" style="font-size: 36px; margin-bottom: 8px;">📱</div>
        <div id="uploadText" style="font-weight: 600; font-size: 15px; margin-bottom: 4px;">
          Tap to choose your ${mediaWord}
        </div>
        <div id="uploadHint" style="color: var(--ugme-muted); font-size: 13px;">
          ${isVideo ? "MP4 or MOV, max 100 MB" : "JPG or PNG, max 100 MB"}
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
          <span style="font-size: 14px; font-weight: 600;">Uploading…</span>
          <span id="progressPercent" style="font-size: 14px; color: var(--ugme-muted);">0%</span>
        </div>
        <div class="ugme-progress-bar">
          <div id="progressFill" class="ugme-progress-fill" style="width: 0%;"></div>
        </div>
      </div>

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
            <span>If approved, your discount (${escapeHtml(reward)}) is applied automatically to your next subscription charge.</span>
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

      // Form submission — for now, submit as multipart/form-data
      // Later: upload to R2 first, then POST content URL
      form.addEventListener('submit', function(e) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        submitBtn.style.opacity = '0.7';
        // Let the form submit natively for now
      });
    })();
    </script>
  `;

  const html = proxyLayout({ title: "Submit", brandName, logoUrl: shop.logoUrl, shopDomain: shop.shopDomain, body });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── C9 POST: Process submission ─────────────────────────────────

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

async function handleSubmitAction(campaignId: string, shop: ShopInfo, brandName: string, loggedInCustomerId: string, request: Request) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, title: true, shopId: true, status: true, contentType: true },
  });

  if (!campaign || campaign.shopId !== shop.id || campaign.status !== "ACTIVE") {
    return new Response(null, {
      status: 302,
      headers: { Location: `/apps/ugme?shop=${shop.shopDomain}` },
    });
  }

  const customer = await findOrCreateCustomer(shop.id, loggedInCustomerId, shop.accessToken, shop.shopDomain);

  // Check duplicate
  const existing = await prisma.submission.findFirst({
    where: { campaignId, customerId: customer.id },
  });
  if (existing) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/apps/ugme/campaign/${campaignId}/submitted?shop=${shop.shopDomain}&already=1` },
    });
  }

  // Parse the multipart form data
  let description = "";
  let file: File | null = null;
  try {
    const formData = await request.formData();
    description = (formData.get("message") as string) || "";
    file = formData.get("file") as File | null;
  } catch (err) {
    console.error("[UGME] Form parse error:", err);
    return errorRedirect(shop.shopDomain, campaignId, "upload_failed");
  }

  if (!file || file.size === 0) {
    return errorRedirect(shop.shopDomain, campaignId, "no_file");
  }

  if (file.size > MAX_UPLOAD_BYTES) {
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
      rewardMonths: true,
      discountType: true,
      discountValue: true,
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
            <span>If approved, <strong>${escapeHtml(reward)}</strong> is applied to your next subscription charge automatically.</span>
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
          rewardMonths: true,
          discountType: true,
          discountValue: true,
          productImageUrl: true,
        },
      },
      reward: {
        select: {
          status: true,
          months: true,
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
          ${s.status === "APPROVED" ? `<div style="font-size: 13px; color: var(--ugme-success);">${escapeHtml(reward)} — applied to subscription</div>` : ""}
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
          rewardMonths: true,
          discountType: true,
          discountValue: true,
          productTitle: true,
          productImageUrl: true,
        },
      },
      reward: {
        select: {
          status: true,
          months: true,
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
      : '<p style="font-size: 13px; color: #065f46; margin: 4px 0 0 0;">Will be applied to your next subscription charge</p>';
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
