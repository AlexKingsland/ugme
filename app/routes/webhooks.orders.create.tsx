import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordOrder } from "../utils/attribution.server";

/** Records every order (for "% of store revenue") and the lines the Social Wall drove. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  try {
    const result = await recordOrder(shop, payload);
    if ("recorded" in result && result.attributedLines) {
      console.log(`[sales] ${topic} ${shop}: ${result.attributedLines} wall-attributed line(s)`);
    }
  } catch (err) {
    console.error(`[sales] couldn't record ${topic} for ${shop}:`, err);
    return new Response(null, { status: 500 }); // Shopify retries
  }
  return new Response();
};
