import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { syncCampaignMetaobjects } from "../../utils/canvas.server";

const BLOCK_HANDLE = "ugme-canvas";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Make sure every campaign is pickable in the theme editor before the merchant goes there.
  const sync = await syncCampaignMetaobjects(admin.graphql, session.shop).catch((err) => ({
    synced: 0,
    errors: [String(err?.message || err)],
  }));

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  const campaigns = shop
    ? await prisma.campaign.findMany({
        where: { shopId: shop.id, status: { not: "DRAFT" } },
        select: {
          id: true,
          title: true,
          status: true,
          submissions: {
            where: { status: "APPROVED", rightsAccepted: true },
            select: { contentType: true },
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  // Numeric app ID — needed once in the block schema (metaobject_type) during setup.
  let appId: string | null = null;
  try {
    const res = await admin.graphql(`{ currentAppInstallation { app { id } } }`);
    const data = (await res.json()) as { data?: { currentAppInstallation?: { app?: { id?: string } } } };
    appId = data.data?.currentAppInstallation?.app?.id?.split("/").pop() ?? null;
  } catch {
    appId = null;
  }

  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const addToThemeUrl = `https://${session.shop}/admin/themes/current/editor?template=index&addAppBlockId=${apiKey}/${BLOCK_HANDLE}&target=newAppsSection`;

  return json({
    addToThemeUrl,
    appId,
    syncErrors: sync.errors,
    campaigns: campaigns.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      videos: c.submissions.filter((s) => s.contentType === "VIDEO").length,
      photos: c.submissions.filter((s) => s.contentType === "PHOTO").length,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const result = await syncCampaignMetaobjects(admin.graphql, session.shop);
  return json(result);
};

export default function SocialWallPage() {
  const { addToThemeUrl, campaigns, syncErrors, appId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const syncing = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? syncErrors;

  return (
    <Page
      title="Social Wall"
      subtitle="An explorable wall of your customers' approved photos and videos, right on your storefront."
      primaryAction={{ content: "Add to theme", url: addToThemeUrl, external: true }}
      secondaryActions={[
        { content: syncing ? "Syncing…" : "Sync campaigns", loading: syncing, onAction: () => fetcher.submit({}, { method: "post" }) },
      ]}
    >
      <Layout>
        {errors.length > 0 && (
          <Layout.Section>
            <Banner tone="warning" title="Some campaigns couldn't be synced to your theme editor">
              <List>
                {errors.slice(0, 5).map((e, i) => (
                  <List.Item key={i}>{e}</List.Item>
                ))}
              </List>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                How it works
              </Text>
              <List type="number">
                <List.Item>
                  Click <b>Add to theme</b>. The theme editor opens with the Social Wall section added to your home page.
                </List.Item>
                <List.Item>
                  In the section settings, choose which <b>Campaigns</b> to show. Leave it empty to show every active
                  campaign.
                </List.Item>
                <List.Item>
                  Save. Shoppers can drag and zoom through the wall, and tap a video to play it.
                </List.Item>
              </List>
              <Text as="p" tone="subdued">
                Only approved submissions where the customer accepted the content rights are shown. New approvals
                appear within a few minutes.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <Text as="h2" variant="headingMd">
                Campaigns available in the theme editor
              </Text>
            </Box>
            {campaigns.length === 0 ? (
              <Box padding="400" paddingBlockStart="0">
                <Text as="p" tone="subdued">
                  No published campaigns yet. Draft campaigns aren't shown on the storefront.
                </Text>
              </Box>
            ) : (
              campaigns.map((c) => (
                <Box key={c.id} padding="400" borderBlockStartWidth="025" borderColor="border">
                  <InlineStack align="space-between" blockAlign="center" gap="400">
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {c.title}
                      </Text>
                      <Text as="span" tone="subdued">
                        {c.videos} video{c.videos === 1 ? "" : "s"} · {c.photos} photo{c.photos === 1 ? "" : "s"} ready
                        to show
                      </Text>
                    </BlockStack>
                    <Badge tone={c.status === "ACTIVE" ? "success" : undefined}>
                      {c.status.charAt(0) + c.status.slice(1).toLowerCase()}
                    </Badge>
                  </InlineStack>
                </Box>
              ))
            )}
          </Card>
        </Layout.Section>

        {appId && process.env.NODE_ENV !== "production" && (
          <Layout.Section>
            <Text as="p" tone="subdued" variant="bodySm">
              Developer: app ID {appId}. Run <code>npm run canvas:set-app-id -- {appId}</code> once so the theme block can
              list campaigns.
            </Text>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
