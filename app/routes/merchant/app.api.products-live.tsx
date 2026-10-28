import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import { liveOnlineStoreProducts } from "../../utils/product-availability.server";

/** POST { ids: string[] } → { live: string[] } — which products shoppers can open on the Online Store. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { ids } = (await request.json().catch(() => ({ ids: [] }))) as { ids?: string[] };
  const live = await liveOnlineStoreProducts(admin.graphql, (ids || []).slice(0, 100));
  return json({ live: live ? [...live] : null });
};
