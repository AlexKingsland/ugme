import crypto from "crypto";

/**
 * Verify the Shopify app proxy request signature.
 * Shopify signs every proxied request with the app's API secret.
 * https://shopify.dev/docs/apps/online-store/app-proxy#verify-the-signature
 */
export function verifyProxySignature(url: URL): {
  valid: boolean;
  shop: string | null;
  loggedInCustomerId: string | null;
} {
  const params = url.searchParams;
  const signature = params.get("signature");
  const shop = params.get("shop");

  if (!signature || !shop) {
    // In dev without proxy, allow direct access with ?shop= param
    if (shop && process.env.NODE_ENV !== "production") {
      return {
        valid: true,
        shop,
        loggedInCustomerId: params.get("logged_in_customer_id"),
      };
    }
    return { valid: false, shop: null, loggedInCustomerId: null };
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.warn("[proxy-auth] No SHOPIFY_API_SECRET set, skipping signature verification");
    return {
      valid: true,
      shop,
      loggedInCustomerId: params.get("logged_in_customer_id"),
    };
  }

  // Build the query string for verification (all params except "signature", sorted)
  const sortedParams = Array.from(params.entries())
    .filter(([key]) => key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("");

  const computed = crypto
    .createHmac("sha256", secret)
    .update(sortedParams)
    .digest("hex");

  return {
    valid: computed === signature,
    shop,
    loggedInCustomerId: params.get("logged_in_customer_id"),
  };
}
