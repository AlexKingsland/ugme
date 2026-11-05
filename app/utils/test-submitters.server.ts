/**
 * Test / bootstrap accounts that may post to the same wall more than once.
 *
 * Set in the server environment only (never in the database or admin UI), so no
 * merchant or shopper can turn it on:
 *
 *   TEST_SUBMITTERS="me@example.com, my-store.myshopify.com:me@example.com"
 *
 * - "email"            → that customer, on any store the app is installed on
 * - "shop:email"       → only on that store (preferred in production)
 *
 * Only the one-post-per-wall rule is lifted. Everything else still applies:
 * verified buyer, wall open, spots left, storage, review, rewards (one per post).
 */

type Entry = { shop: string | null; email: string };

let cachedRaw: string | undefined;
let cached: Entry[] = [];

function entries(): Entry[] {
  const raw = process.env.TEST_SUBMITTERS || "";
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      return i > 0 ? { shop: s.slice(0, i), email: s.slice(i + 1) } : { shop: null, email: s };
    })
    .filter((e) => e.email.includes("@"));
  return cached;
}

export function canPostUnlimited(shopDomain: string, email: string | null | undefined): boolean {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  const shop = shopDomain.trim().toLowerCase();
  const allowed = entries().some((x) => x.email === e && (x.shop === null || x.shop === shop));
  if (allowed) console.log(`[test-submitters] ${e} on ${shop}: one-post-per-wall limit skipped`);
  return allowed;
}
