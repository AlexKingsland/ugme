import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { getProviderAdapter } from "../../utils/providers";

/**
 * API route to check whether a product has subscription support.
 * Asks the merchant's connected subscription provider adapter
 * (see app/utils/providers) whether the product has subscriptions.
 *
 * GET /app/api/check-selling-plans?productId=gid://shopify/Product/123
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ hasSellingPlans: false });
  }

  // Look up the shop's subscription provider config
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: {
      subscriptionProvider: true,
      providerConnected: true,
      providerApiKey: true,
    },
  });

  if (!shop?.providerConnected) {
    return json({ hasSellingPlans: false });
  }

  try {
    const provider = getProviderAdapter(shop.subscriptionProvider);
    const hasSellingPlans = await provider.productHasSubscriptions(
      { apiKey: shop.providerApiKey, admin },
      productId,
    );
    return json({ hasSellingPlans });
  } catch (error) {
    console.error("[UGME] check-selling-plans error:", error);
    return json({ hasSellingPlans: false });
  }
};
