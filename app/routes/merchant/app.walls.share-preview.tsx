/**
 * "Customers see" preview: renders the real customer share page from the wall
 * editor's current (unsaved) form, so merchants see exactly what customers get.
 * POST { form, id } → { html }. Nothing is saved; the page can't submit.
 */
import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import type { WallForm } from "../../utils/wall-validate";
import { renderSubmitPage, productNames } from "../../utils/proxy-routes.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { shopDomain: true, logoUrl: true, supportEmail: true, brandName: true },
  });
  if (!shop) return json({ html: "" }, { status: 404 });
  const { form, id } = (await request.json()) as { form: WallForm; id?: string | null };
  const brandName = shop.brandName || shop.shopDomain.replace(".myshopify.com", "");
  const products = form.productScope === "ALL" ? [] : form.products || [];
  const campaign = {
    id: id || "preview",
    moment: form.moment || "",
    captionPrompt: form.question?.trim() || null,
    contentType: form.contentType,
    captureSpecs: JSON.stringify((form.checklist || []).filter(Boolean).map((d) => ({ label: "Requirement", description: d }))),
    productScope: form.productScope,
    products: JSON.stringify(products),
    maxSubmissions: form.hasLimit ? Number(form.maxSubmissions) || null : null,
    rewardType: form.rewardType,
    discountCodeType: form.discountCodeType,
    discountCodeAmount: Number(form.discountCodeAmount) || 0,
    discountCodeExpiryDays: Number(form.discountCodeExpiryDays) || null,
    storeCreditAmount: Number(form.storeCreditAmount) || 0,
    storeCreditExpiryDays: Number(form.storeCreditExpiryDays) || null,
  };
  const html = renderSubmitPage({
    campaign,
    shop,
    brandName,
    remaining: campaign.maxSubmissions,
    verifiedText: productNames(campaign),
    errorParam: null,
    preview: true,
  });
  return json({ html });
};
