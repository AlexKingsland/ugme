import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Tests the connection to the selected subscription provider.
 * - Shopify Native: verifies we can query the GraphQL Admin API for discount capabilities
 * - ReCharge: verifies the provided API key by calling GET /discounts with limit=1
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const provider = formData.get("provider") as string;
  const apiKey = formData.get("apiKey") as string;

  try {
    if (provider === "SHOPIFY_NATIVE") {
      // Test that we can access the discounts API
      const response = await admin.graphql(
        `#graphql
        query {
          codeDiscountNodes(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }`
      );
      const data: any = await response.json();

      if (data.errors && data.errors.length > 0) {
        return json({
          success: false,
          error: "Cannot access Shopify Discounts API. Make sure the app has the 'write_discounts' scope.",
        });
      }

      return json({
        success: true,
        message: "Connected to Shopify Native Discounts. You're all set to create discount codes for approved submissions.",
      });
    }

    if (provider === "RECHARGE") {
      if (!apiKey || apiKey.trim() === "") {
        return json({
          success: false,
          error: "Please enter your ReCharge API token.",
        });
      }

      // Test the ReCharge API key by listing discounts
      const response = await fetch(
        "https://api.rechargeapps.com/discounts?limit=1",
        {
          headers: {
            "X-Recharge-Access-Token": apiKey.trim(),
            "Content-Type": "application/json",
          },
        },
      );

      if (response.status === 401 || response.status === 403) {
        return json({
          success: false,
          error: "Invalid ReCharge API token. Please check your token and try again.",
        });
      }

      if (!response.ok) {
        return json({
          success: false,
          error: `ReCharge API returned status ${response.status}. Please try again.`,
        });
      }

      return json({
        success: true,
        message: "Connected to ReCharge. UGME can now create and apply discounts for approved submissions.",
      });
    }

    return json({ success: false, error: "Unknown provider." });
  } catch (error) {
    return json({
      success: false,
      error: `Connection test failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
};
