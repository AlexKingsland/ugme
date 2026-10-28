type AdminGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

/**
 * Products shoppers can actually open on the storefront: ACTIVE and published
 * to the Online Store (publishedAt is the Online Store publish date).
 * Returns null when Shopify couldn't be asked (callers should then not block).
 */
export async function liveOnlineStoreProducts(graphql: AdminGraphql, ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set();
  try {
    const res = await graphql(
      `#graphql
      query WallLiveProducts($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id status publishedAt } } }`,
      { variables: { ids } },
    );
    const body: any = await res.json();
    if (body?.errors?.length) return null;
    const live = new Set<string>();
    for (const n of body?.data?.nodes ?? []) if (n?.status === "ACTIVE" && n.publishedAt) live.add(n.id);
    return live;
  } catch {
    return null;
  }
}
