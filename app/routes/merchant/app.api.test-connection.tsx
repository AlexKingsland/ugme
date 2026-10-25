import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import { getProviderAdapter } from "../../utils/providers";

/**
 * Tests the connection to the selected subscription provider.
 * Each provider adapter decides what "connected" means — e.g. Recharge
 * validates every endpoint UGME needs (see recharge.adapter.ts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const provider = formData.get("provider") as string;
  const apiKey = formData.get("apiKey") as string;

  let adapter;
  try {
    adapter = getProviderAdapter(provider);
  } catch {
    return json({ success: false, error: "Unknown provider." });
  }

  try {
    return json(await adapter.testConnection({ apiKey, admin }));
  } catch (error) {
    return json({
      success: false,
      error: `Connection test failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
};
