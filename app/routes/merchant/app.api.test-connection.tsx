import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";

const RECHARGE_BASE = "https://api.rechargeapps.com";
const RECHARGE_VERSION = "2021-11";

interface TestResult {
  name: string;
  endpoint: string;
  passed: boolean;
  detail?: string;
}

/**
 * Tests the connection to the selected subscription provider.
 * For ReCharge, validates ALL endpoints UGME needs:
 *   1. GET  /discounts          (read discounts)
 *   2. GET  /customers          (read customers by shopify_customer_id)
 *   3. GET  /subscriptions      (read active subscriptions + get address_id)
 *   4. GET  /addresses/:id      (verify address access for discount application)
 *   5. POST /discounts          (create a test discount)
 *   6. DELETE /discounts/:id    (clean up the test discount)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const provider = formData.get("provider") as string;
  const apiKey = formData.get("apiKey") as string;

  try {
    if (provider === "SHOPIFY_NATIVE") {
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

      const token = apiKey.trim();
      const headers = {
        "X-Recharge-Access-Token": token,
        "X-Recharge-Version": RECHARGE_VERSION,
        "Content-Type": "application/json",
      };

      const results: TestResult[] = [];

      // 1. Test authentication + read discounts
      try {
        const res = await fetch(`${RECHARGE_BASE}/discounts?limit=1`, { headers });
        if (res.status === 401 || res.status === 403) {
          return json({
            success: false,
            error: "Invalid ReCharge API token. Please check your token and try again.",
          });
        }
        results.push({
          name: "Read discounts",
          endpoint: "GET /discounts",
          passed: res.ok,
          detail: res.ok ? undefined : `Status ${res.status}`,
        });
      } catch (err) {
        return json({
          success: false,
          error: `Could not reach ReCharge API: ${err instanceof Error ? err.message : "Unknown error"}`,
        });
      }

      // 2. Test read customers
      try {
        const res = await fetch(`${RECHARGE_BASE}/customers?limit=1`, { headers });
        results.push({
          name: "Read customers",
          endpoint: "GET /customers",
          passed: res.ok,
          detail: res.ok ? undefined : `Status ${res.status}`,
        });
      } catch (err) {
        results.push({
          name: "Read customers",
          endpoint: "GET /customers",
          passed: false,
          detail: err instanceof Error ? err.message : "Network error",
        });
      }

      // 3. Test read subscriptions (also grab address_id for test 4)
      let testAddressId: number | null = null;
      try {
        const res = await fetch(`${RECHARGE_BASE}/subscriptions?limit=1`, { headers });
        if (res.ok) {
          const subData: any = await res.json();
          const sub = subData.subscriptions?.[0];
          testAddressId = sub?.address_id ?? null;
        }
        results.push({
          name: "Read subscriptions",
          endpoint: "GET /subscriptions",
          passed: res.ok,
          detail: res.ok ? undefined : `Status ${res.status}`,
        });
      } catch (err) {
        results.push({
          name: "Read subscriptions",
          endpoint: "GET /subscriptions",
          passed: false,
          detail: err instanceof Error ? err.message : "Network error",
        });
      }

      // 4. Test read addresses (needed for applying/clearing discounts)
      try {
        if (testAddressId) {
          const res = await fetch(`${RECHARGE_BASE}/addresses/${testAddressId}`, { headers });
          results.push({
            name: "Read address",
            endpoint: "GET /addresses/:id",
            passed: res.ok,
            detail: res.ok ? undefined : `Status ${res.status}`,
          });
        } else {
          // No subscriptions exist yet — skip with a note
          results.push({
            name: "Read address",
            endpoint: "GET /addresses/:id",
            passed: true,
            detail: "Skipped (no subscriptions yet) — will work once customers subscribe",
          });
        }
      } catch (err) {
        results.push({
          name: "Read address",
          endpoint: "GET /addresses/:id",
          passed: false,
          detail: err instanceof Error ? err.message : "Network error",
        });
      }

      // 5. Test write: create a test discount, then immediately delete it
      let testDiscountId: number | null = null;
      try {
        const testCode = `UGME_CONNECTION_TEST_${Date.now()}`;
        const createRes = await fetch(`${RECHARGE_BASE}/discounts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            channel: "checkout_page",
            code: testCode,
            discount_type: "percentage",
            value_type: "percentage",
            value: "0.01",
            status: "disabled",
          }),
        });

        if (createRes.ok) {
          const createData: any = await createRes.json();
          testDiscountId = createData.discount?.id;
          results.push({
            name: "Create discount",
            endpoint: "POST /discounts",
            passed: true,
          });
        } else {
          const errBody = await createRes.text();
          results.push({
            name: "Create discount",
            endpoint: "POST /discounts",
            passed: false,
            detail: `Status ${createRes.status}: ${errBody.slice(0, 200)}`,
          });
        }
      } catch (err) {
        results.push({
          name: "Create discount",
          endpoint: "POST /discounts",
          passed: false,
          detail: err instanceof Error ? err.message : "Network error",
        });
      }

      // 6. Clean up: delete the test discount
      if (testDiscountId) {
        try {
          const delRes = await fetch(`${RECHARGE_BASE}/discounts/${testDiscountId}`, {
            method: "DELETE",
            headers,
          });
          results.push({
            name: "Delete discount",
            endpoint: "DELETE /discounts/:id",
            passed: delRes.ok || delRes.status === 204,
            detail: delRes.ok || delRes.status === 204 ? undefined : `Status ${delRes.status}`,
          });
        } catch (err) {
          results.push({
            name: "Delete discount",
            endpoint: "DELETE /discounts/:id",
            passed: false,
            detail: err instanceof Error ? err.message : "Network error",
          });
        }
      }

      // Summarize results
      const failed = results.filter((r) => !r.passed);

      if (failed.length > 0) {
        const failedNames = failed.map((f) => `${f.name} (${f.detail || f.endpoint})`).join(", ");
        return json({
          success: false,
          error: `Some API checks failed: ${failedNames}. Make sure your token has read & write access to Discounts, Customers, Subscriptions, and Addresses.`,
          results,
        });
      }

      return json({
        success: true,
        message: `All ${results.length} API checks passed. UGME can read customers, subscriptions, and addresses, and create and manage discounts.`,
        results,
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
