import { type RouteConfig, route, layout, index, prefix } from "@remix-run/route-config";
import { flatRoutes } from "@remix-run/fs-routes";

export default [
  // Infrastructure routes (auth, webhooks, root redirect)
  ...(await flatRoutes({ ignoredRouteFiles: ["merchant/**"] })),

  // ── Merchant routes (Shopify embedded admin, Polaris UI) ──────────
  ...prefix("app", [
    layout("routes/merchant/app.tsx", [
      index("routes/merchant/app._index.tsx"),
      route("walls", "routes/merchant/app.walls.tsx"),
      route("walls/:id", "routes/merchant/app.walls.$id.tsx"),
      // old links → wall campaigns
      route("campaigns/*", "routes/merchant/app.campaigns-redirect.tsx"),
      route("library/:id", "routes/merchant/app.library.$id.tsx"),
      route("library", "routes/merchant/app.library.tsx"),
      route("settings", "routes/merchant/app.settings.tsx"),
      route("api/products-live", "routes/merchant/app.api.products-live.tsx"),
      route("settings/billing", "routes/merchant/app.settings.billing.tsx"),
    ]),
  ]),

  // Customer-facing share flow is served via the Shopify App Proxy
  // at /apps/social-wall/* — handled by routes/api.proxy.$.tsx (auto-discovered
  // by flatRoutes above). No separate customer routes needed.
] satisfies RouteConfig;
