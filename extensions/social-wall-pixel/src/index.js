/**
 * Social Wall — checkout pixel.
 *
 * "Buy it now" checkouts skip the cart, so the cart attribute with the shopper's
 * watched wall posts never reaches the order. On checkout_completed this reads the
 * same list from the storefront's localStorage (written by the wall) and reports it,
 * with the order id, to the app through the app proxy. The app credits only products
 * linked to those posts, bought within 7 days of watching.
 */
import { register } from "@shopify/web-pixels-extension";

const STORAGE_KEY = "social_wall_seen";

register(({ analytics, browser, settings, init }) => {
  analytics.subscribe("checkout_completed", async (event) => {
    try {
      const orderId = event?.data?.checkout?.order?.id;
      if (!orderId) return;
      const seen = await browser.localStorage.getItem(STORAGE_KEY);
      if (!seen || seen === "[]") return;

      const origin =
        event?.context?.document?.location?.origin || init?.context?.document?.location?.origin;
      if (!origin) return;
      const url = `${origin}${settings.proxyPath || "/apps/social-wall"}/pixel`;
      const body = JSON.stringify({ orderId, seen });

      const sent = await browser.sendBeacon(url, body).catch(() => false);
      if (!sent) fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    } catch {
      // never break checkout analytics
    }
  });
});
