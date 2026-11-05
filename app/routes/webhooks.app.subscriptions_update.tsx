import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncPlanFromShopify } from "../utils/billing.server";

/** Plan approved, cancelled, frozen or replaced in Shopify → update the store's plan. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await authenticate.webhook(request);
  if (admin) await syncPlanFromShopify(admin.graphql, shop);
  return new Response();
};
