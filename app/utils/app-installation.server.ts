/**
 * Small app-owned values stored on the app's installation (app-data metafields),
 * readable by the theme block as `app.metafields.social_wall.<key>`.
 *
 * - api_key: this app's client id, so the block's "Create / Open wall campaign"
 *   links open the right app (production vs the dev app).
 */
type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

const done = new Set<string>();

export async function syncInstallationMetafields(graphql: Graphql, shopDomain: string): Promise<boolean> {
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return false;
  try {
    const idRes = await graphql(`#graphql
      query SocialWallInstallation { currentAppInstallation { id } }`);
    const ownerId = ((await idRes.json()) as any)?.data?.currentAppInstallation?.id;
    if (!ownerId) return false;
    const res = await graphql(`#graphql
      mutation SocialWallInstallationMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`, {
      variables: {
        metafields: [{ ownerId, namespace: "social_wall", key: "api_key", type: "single_line_text_field", value: apiKey }],
      },
    });
    const errs = ((await res.json()) as any)?.data?.metafieldsSet?.userErrors || [];
    if (errs.length) {
      console.warn(`[install] metafields for ${shopDomain}:`, JSON.stringify(errs));
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[install] metafields for ${shopDomain} failed:`, err);
    return false;
  }
}

/** Fire-and-forget from the admin layout: once per store per server process. */
export function maybeSyncInstallationMetafields(graphql: Graphql, shopDomain: string) {
  if (done.has(shopDomain)) return;
  done.add(shopDomain);
  syncInstallationMetafields(graphql, shopDomain).then((ok) => {
    if (!ok) done.delete(shopDomain); // try again on a later admin visit
  });
}
