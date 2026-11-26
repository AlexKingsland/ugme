// Customer-facing App Proxy pages (/apps/social-wall/*). The implementation lives in
// utils/proxy-routes.server.ts so other server code can reuse its page renderers.
import { loader as proxyLoader, action as proxyAction } from "../utils/proxy-routes.server";

export const loader = proxyLoader;
export const action = proxyAction;
