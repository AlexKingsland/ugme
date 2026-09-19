import { type RouteConfig, route, layout, index, prefix } from "@remix-run/route-config";
import { flatRoutes } from "@remix-run/fs-routes";

export default [
  // Infrastructure routes (auth, webhooks, root redirect)
  // Ignore merchant/ and customer/ subdirs — those are wired manually below
  ...(await flatRoutes({ ignoredRouteFiles: ["merchant/**", "customer/**"] })),

  // ── Merchant routes (Shopify embedded admin, Polaris UI) ──────────
  // All under /app — the Shopify admin loads the app at /app
  ...prefix("app", [
    layout("routes/merchant/app.tsx", [
      index("routes/merchant/app._index.tsx"),
      route("campaigns", "routes/merchant/app.campaigns.tsx"),
      route("campaigns/:id", "routes/merchant/app.campaigns.$id.tsx"),
      route("submissions", "routes/merchant/app.submissions.tsx"),
      route("submissions/:id", "routes/merchant/app.submissions.$id.tsx"),
      route("settings", "routes/merchant/app.settings.tsx"),
      route("api/test-connection", "routes/merchant/app.api.test-connection.tsx"),
    ]),
  ]),

  // ── Customer routes (public submission portal) ────────────────────
  ...prefix("submit", [
    layout("routes/customer/submit.tsx", [
      index("routes/customer/submit._index.tsx"),
      route(":campaignId", "routes/customer/submit.$campaignId.tsx"),
      route("confirmation", "routes/customer/submit.confirmation.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
