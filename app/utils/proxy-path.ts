/**
 * Storefront path of the app proxy (shopify.app.toml → [app_proxy] prefix/subpath).
 * Every customer-facing link uses this, so the path can change in one place.
 */
export const PROXY_PREFIX = "apps";
export const PROXY_SUBPATH = "social-wall";
export const PROXY_BASE = `/${PROXY_PREFIX}/${PROXY_SUBPATH}`;
