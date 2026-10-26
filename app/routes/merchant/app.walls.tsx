import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  EmptyState,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Box,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { parseProducts } from "../../utils/wall-campaigns";
import { campaignRewardLabel } from "../../utils/rewards/presenters";
import { getWallUsage, addToThemeUrl } from "../../utils/wall-theme.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  const walls = shop
    ? await prisma.campaign.findMany({
        where: { shopId: shop.id, rewardType: { not: "SUBSCRIPTION_DISCOUNT" }, status: { not: "CLOSED" } },
        select: {
          id: true,
          title: true,
          status: true,
          productScope: true,
          products: true,
          rewardType: true,
          discountType: true,
          discountValue: true,
          rewardCycles: true,
          rewardFrequency: true,
          discountCodeType: true,
          discountCodeAmount: true,
          storeCreditAmount: true,
          _count: { select: { submissions: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const pending = shop
    ? await prisma.submission.groupBy({
        by: ["campaignId"],
        where: { campaign: { shopId: shop.id }, status: "PENDING" },
        _count: { _all: true },
      })
    : [];
  const pendingBy = Object.fromEntries(pending.map((p) => [p.campaignId, p._count._all]));
  const usage = walls.length ? await getWallUsage(admin.graphql, walls.map((w) => w.id)) : { status: "ok" as const, byCampaign: {} };

  return json({
    addToThemeUrl: addToThemeUrl(session.shop, process.env.SHOPIFY_API_KEY || ""),
    usageKnown: usage.status === "ok",
    walls: walls.map((w) => {
      const products = parseProducts(w.products);
      return {
        id: w.id,
        title: w.title,
        status: w.status,
        productsLabel:
          w.productScope === "ALL"
            ? "All products"
            : products.length === 1
              ? products[0].title
              : `${products.length} products`,
        image: products[0]?.imageUrl ?? null,
        reward: campaignRewardLabel(w),
        posts: w._count.submissions,
        pending: pendingBy[w.id] ?? 0,
        usedOn: usage.status === "ok" ? usage.byCampaign[w.id] ?? [] : null,
      };
    }),
  });
};

const STATUS: Record<string, { tone?: "success" | "attention" | "info"; label: string }> = {
  ACTIVE: { tone: "success", label: "Active" },
  PAUSED: { tone: "attention", label: "Paused" },
  DRAFT: { tone: "info", label: "Draft" },
};

export default function WallCampaigns() {
  const { walls, addToThemeUrl, usageKnown } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  if (!walls.length) {
    return (
      <Page title="Wall campaigns">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Create your first Social Wall"
                action={{ content: "Create wall campaign", onAction: () => navigate("/app/walls/new") }}
                secondaryAction={{ content: "Open theme editor", url: addToThemeUrl, target: "_top" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <BlockStack gap="300">
                  <p>Turn your customers into your best content. Verified buyers share videos of your products, you approve the best, and they appear on an interactive wall in your store.</p>
                  <Box>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">How it works</Text>
                    <Text as="p" variant="bodyMd" tone="subdued">1. Create a wall campaign: pick products, what to ask for, and the reward.</Text>
                    <Text as="p" variant="bodyMd" tone="subdued">2. Add the Social Wall block in your theme editor and choose the wall campaign.</Text>
                    <Text as="p" variant="bodyMd" tone="subdued">3. Activate it — the wall appears in your store.</Text>
                  </Box>
                </BlockStack>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Wall campaigns"
      primaryAction={{ content: "Create wall campaign", onAction: () => navigate("/app/walls/new") }}
      secondaryActions={[{ content: "Open theme editor", url: addToThemeUrl, target: "_top" }]}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <ResourceList
              resourceName={{ singular: "wall campaign", plural: "wall campaigns" }}
              items={walls}
              renderItem={(w) => {
                const st = STATUS[w.status] ?? { label: w.status };
                const where =
                  w.usedOn === null
                    ? null
                    : w.usedOn.length
                      ? `On your theme: ${w.usedOn.join(", ")}`
                      : "Not on your live theme yet";
                return (
                  <ResourceItem
                    id={w.id}
                    url={`/app/walls/${w.id}`}
                    media={<Thumbnail source={w.image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_small.png"} alt="" size="small" />}
                    accessibilityLabel={`Open ${w.title}`}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <div style={{ minWidth: 0 }}>
                            <Text as="h3" variant="bodyMd" fontWeight="semibold" truncate>{w.title}</Text>
                          </div>
                          <div style={{ flex: "0 0 auto" }}>
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </div>
                        </div>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {w.productsLabel} · {w.reward}
                        </Text>
                        {where && (
                          <Text as="p" variant="bodySm" tone={w.usedOn && w.usedOn.length ? "success" : "caution"}>
                            {where}
                          </Text>
                        )}
                      </div>
                      <BlockStack gap="100" inlineAlign="end">
                        <Text as="p" variant="bodySm">{w.posts} submission{w.posts === 1 ? "" : "s"}</Text>
                        {w.pending > 0 && <Badge tone="attention">{`${w.pending} to review`}</Badge>}
                      </BlockStack>
                    </div>
                  </ResourceItem>
                );
              }}
            />
          </Card>
        </Layout.Section>
        {!usageKnown && (
          <Layout.Section>
            <Banner tone="info">We couldn't read your theme to show where each wall is used. Reopen the app to approve the latest permissions.</Banner>
          </Layout.Section>
        )}
        <Layout.Section>
          <Text as="p" variant="bodySm" tone="subdued">
            To show a wall: in the theme editor, add the Social Wall block and choose the wall campaign. It only appears on your store while the wall campaign is active.
          </Text>
          <Box paddingBlockStart="200">
            <Button url={addToThemeUrl} target="_top" variant="plain">Add Social Wall to your home page</Button>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
