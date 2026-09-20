import { type RouteConfig, route, layout, index, prefix } from "@remix-run/route-config";
import { flatRoutes } from "@remix-run/fs-routes";

export default [
  // Infrastructure routes (auth, webhooks, root redirect)
  ...(await flatRoutes({ ignoredRouteFiles: ["merchant/**", "customer/**"] })),

  // ── Merchant routes (Shopify embedded admin, Polaris UI) ──────────
  ...prefix("app", [
    layout("routes/merchant/app.tsx", [
      index("routes/merchant/app._index.tsx"),
      route("campaigns", "routes/merchant/app.campaigns.tsx"),
      route("campaigns/new", "routes/merchant/app.campaigns.new.tsx"),
      route("campaigns/:id", "routes/merchant/app.campaigns.$id.tsx"),
      route("campaigns/:id/edit", "routes/merchant/app.campaigns.$id.edit.tsx"),
      route("campaigns/:id/live", "routes/merchant/app.campaigns.$id.live.tsx"),
      route("library/:id", "routes/merchant/app.library.$id.tsx"),
      route("library", "routes/merchant/app.library.tsx"),
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
