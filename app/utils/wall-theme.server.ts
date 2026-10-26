/**
 * Where is each wall campaign used in the live theme? Reads the main theme's
 * JSON templates (needs `read_themes`) and looks for Social Wall blocks whose
 * "Wall campaign" setting points at the wall's metaobject. Best effort: any
 * failure just means "unknown".
 */

type AdminGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

export const THEME_BLOCK_HANDLE = "ugme-canvas";

/** Theme editor deep link that adds the Social Wall block to a template. */
export function addToThemeUrl(shopDomain: string, apiKey: string, template = "index") {
  const store = shopDomain.replace(".myshopify.com", "");
  const params = new URLSearchParams({
    template,
    addAppBlockId: `${apiKey}/${THEME_BLOCK_HANDLE}`,
    target: "newAppsSection",
  });
  return `https://admin.shopify.com/store/${store}/themes/current/editor?${params.toString()}`;
}

export function templateLabel(filename: string): string {
  const name = filename.replace(/^templates\//, "").replace(/^sections\//, "").replace(/\.json$/, "");
  const [base, suffix] = name.split(/\.(.+)/);
  const labels: Record<string, string> = {
    index: "Home page",
    product: "Product pages",
    collection: "Collection pages",
    "list-collections": "Collections list",
    page: "Pages",
    blog: "Blog",
    article: "Blog posts",
    cart: "Cart",
    search: "Search",
  };
  const label = labels[base] || base.replace(/[-_]/g, " ");
  return suffix ? `${label} (${suffix})` : label;
}

export type WallUsage = { status: "ok"; byCampaign: Record<string, string[]> } | { status: "unknown"; reason: string };

export async function getWallUsage(graphql: AdminGraphql, campaignIds: string[]): Promise<WallUsage> {
  try {
    // The theme stores the picked wall campaign as its metaobject handle
    // ("wall-<campaign id>", or "campaign-<id>" from older syncs).
    const handlesByCampaign = new Map<string, string[]>(
      campaignIds.map((id) => [id, [`"wall-${id.toLowerCase()}"`, `"campaign-${id.toLowerCase()}"`]]),
    );

    const themeRes = await graphql(`#graphql
      query WallThemeFiles {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            files(filenames: ["templates/*.json", "sections/*.json"], first: 250) {
              nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
            }
          }
        }
      }`);
    const themeBody: any = await themeRes.json();
    if (themeBody?.errors?.length) {
      return { status: "unknown", reason: themeBody.errors.map((e: any) => e.message).join("; ") };
    }
    const files: { filename: string; body?: { content?: string } }[] = themeBody?.data?.themes?.nodes?.[0]?.files?.nodes ?? [];

    const byCampaign: Record<string, string[]> = {};
    for (const id of campaignIds) byCampaign[id] = [];
    for (const f of files) {
      const content = f.body?.content || "";
      if (!content.includes(THEME_BLOCK_HANDLE)) continue;
      for (const [campaignId, handles] of handlesByCampaign) {
        if (handles.some((h) => content.includes(h)) && !byCampaign[campaignId].includes(templateLabel(f.filename))) {
          byCampaign[campaignId].push(templateLabel(f.filename));
        }
      }
    }
    return { status: "ok", byCampaign };
  } catch (err) {
    return { status: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}
