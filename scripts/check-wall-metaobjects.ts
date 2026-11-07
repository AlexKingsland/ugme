/**
 * Diagnose the theme editor's "Wall campaign" picker for the app in .env /
 * `shopify app dev` (uses the store's saved offline session).
 *
 *   npm run check:metaobjects [-- your-store.myshopify.com]
 */
import prisma from "../app/db.server";

const TYPE = "$app:ugme_campaign";
const shopArg = process.argv[2];

async function main() {
  const session = await prisma.session.findFirst({
    where: { isOnline: false, ...(shopArg ? { shop: shopArg } : {}) },
    orderBy: { expires: "desc" },
  });
  if (!session) throw new Error("No offline session in the database — open the app in admin once first.");
  console.log(`store: ${session.shop}`);
  const gql = async (query: string, variables: Record<string, unknown> = {}) => {
    const r = await fetch(`https://${session.shop}/admin/api/2026-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    return r.json() as Promise<any>;
  };

  const app = await gql(`{ currentAppInstallation { app { id title apiKey } } }`);
  if (app.errors) console.log("token problem:", JSON.stringify(app.errors));
  console.log(`app: ${app.data?.currentAppInstallation?.app?.title} (client id ${app.data?.currentAppInstallation?.app?.apiKey}, numeric app id ${String(app.data?.currentAppInstallation?.app?.id || "").split("/").pop()})`);

  const def = await gql(`query($t: String!) { metaobjectDefinitionByType(type: $t) { id type name metaobjectsCount fieldDefinitions { key } } }`, { t: TYPE });
  console.log("definition:", JSON.stringify(def.data?.metaobjectDefinitionByType ?? def.errors ?? null));

  if (!def.data?.metaobjectDefinitionByType) {
    const create = await gql(`mutation($d: MetaobjectDefinitionCreateInput!) { metaobjectDefinitionCreate(definition: $d) { metaobjectDefinition { id type } userErrors { field message code } } }`, {
      d: {
        type: TYPE, name: "Wall campaign", displayNameKey: "title",
        access: { admin: "MERCHANT_READ", storefront: "PUBLIC_READ" },
        fieldDefinitions: [
          { key: "title", name: "Title", type: "single_line_text_field", required: true },
          { key: "campaign_id", name: "Campaign ID", type: "single_line_text_field", required: true },
          { key: "status", name: "Status", type: "single_line_text_field" },
          { key: "data_url", name: "Data URL", type: "single_line_text_field" },
        ],
      },
    });
    console.log("tried to create it:", JSON.stringify(create.data?.metaobjectDefinitionCreate ?? create.errors));
  }

  const entries = await gql(`query($t: String!) { metaobjects(type: $t, first: 50) { nodes { handle fields { key value } } } }`, { t: TYPE });
  const nodes = entries.data?.metaobjects?.nodes ?? [];
  console.log(`entries: ${nodes.length}`);
  for (const n of nodes.slice(0, 10)) console.log("  ", n.handle, Object.fromEntries(n.fields.map((f: any) => [f.key, f.value])).title);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
