import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordRefund } from "../utils/attribution.server";

/** Subtracts refunds so wall revenue stays net. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  try {
    await recordRefund(shop, payload);
  } catch (err) {
    console.error(`[sales] couldn't record ${topic} for ${shop}:`, err);
    return new Response(null, { status: 500 });
  }
  return new Response();
};
