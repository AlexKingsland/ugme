import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../../shopify.server";

/** Campaigns are now "wall campaigns" — keep old links working. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const rest = (params["*"] || "").split("/")[0];
  const url = new URL(request.url);
  const target = !rest || rest === "new" ? `/app/walls${rest === "new" ? "/new" : ""}` : `/app/walls/${rest}`;
  return redirect(`${target}${url.search}`);
};
