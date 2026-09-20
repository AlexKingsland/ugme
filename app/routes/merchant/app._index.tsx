import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Box,
  InlineGrid,
  Divider,
  Banner,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

const TIER_LIMITS: Record<string, { bytes: number; label: string }> = {
  TIER_10GB:  { bytes: 10 * 1024 * 1024 * 1024,   label: "10 GB" },
  TIER_100GB: { bytes: 100 * 1024 * 1024 * 1024,  label: "100 GB" },
  TIER_1TB:   { bytes: 1024 * 1024 * 1024 * 1024,  label: "1 TB" },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findFirst({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return json({
      stats: { activeCampaigns: 0, totalSubmissions: 0, pendingReview: 0, rewardsApplied: 0 },
      recentSubmissions: [],
      activeCampaigns: [],
      shopExists: false,
      providerConnected: false,
      storage: { usedBytes: 0, tier: "TIER_10GB" },
    });
  }

  const [activeCampaigns, totalSubmissions, pendingReview, rewardsApplied, storageAgg] =
    await Promise.all([
      prisma.campaign.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
      prisma.submission.count({ where: { campaign: { shopId: shop.id } } }),
      prisma.submission.count({ where: { campaign: { shopId: shop.id }, status: "PENDING" } }),
      prisma.reward.count({ where: { customer: { shopId: shop.id }, status: "APPLIED" } }),
      prisma.submission.aggregate({
        where: { campaign: { shopId: shop.id } },
        _sum: { fileBytes: true },
      }),
    ]);

  const recentSubmissions = await prisma.submission.findMany({
    where: { campaign: { shopId: shop.id } },
    include: {
      customer: { select: { email: true } },
      campaign: { select: { title: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id, status: "ACTIVE" },
    select: {
      id: true,
      title: true,
      rewardMonths: true,
      productTitle: true,
      productImageUrl: true,
      contentType: true,
      _count: { select: { submissions: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  return json({
    stats: { activeCampaigns, totalSubmissions, pendingReview, rewardsApplied },
    recentSubmissions,
    activeCampaigns: campaigns,
    shopExists: true,
    providerConnected: shop.providerConnected,
    storage: {
      usedBytes: storageAgg._sum.fileBytes || 0,
      tier: shop.storageTier,
    },
  });
};

function StatCard({ title, value, helpText }: { title: string; value: number; helpText?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" tone="subdued">{title}</Text>
        <Text as="p" variant="headingXl">{value}</Text>
        {helpText && <Text as="p" variant="bodySm" tone="subdued">{helpText}</Text>}
      </BlockStack>
    </Card>
  );
}

function StorageCard({ usedBytes, tier }: { usedBytes: number; tier: string }) {
  const tierInfo = TIER_LIMITS[tier] || TIER_LIMITS.TIER_10GB;
  const pct = Math.min((usedBytes / tierInfo.bytes) * 100, 100);
  const isHigh = pct >= 80;
  const isCritical = pct >= 95;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Storage</Text>
          <Badge tone={isCritical ? "critical" : isHigh ? "attention" : "info"}>{`${tierInfo.label} plan`}</Badge>
        </InlineStack>

        <ProgressBar
          progress={pct}
          tone={isCritical ? "critical" : isHigh ? "highlight" : "primary"}
          size="small"
        />

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            {formatBytes(usedBytes)} used
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {formatBytes(tierInfo.bytes - usedBytes)} remaining
          </Text>
        </InlineStack>

        {isHigh && (
          <Banner tone={isCritical ? "critical" : "warning"}>
            {isCritical
              ? "You're almost out of storage. Upgrade your plan to keep accepting submissions."
              : "Storage is getting full. Consider upgrading to avoid disruptions."}
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "PENDING":  return <Badge tone="attention">Pending</Badge>;
    case "APPROVED": return <Badge tone="success">Approved</Badge>;
    case "REJECTED": return <Badge tone="critical">Rejected</Badge>;
    case "FLAGGED":  return <Badge tone="warning">Flagged</Badge>;
    default:         return <Badge>{status}</Badge>;
  }
}

export default function Dashboard() {
  const { stats, recentSubmissions, activeCampaigns, shopExists, providerConnected, storage } =
    useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="UGME Dashboard" />
      <BlockStack gap="500">
        {!providerConnected && (
          <Banner
            title="Connect your subscription provider"
            tone="warning"
            action={{ content: "Go to Settings", url: "/app/settings" }}
          >
            <p>
              UGME needs access to your subscription platform to apply discount
              rewards. Connect your provider in Settings to start creating campaigns.
            </p>
          </Banner>
        )}
        {/* Stats Row */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard title="Active Campaigns" value={stats.activeCampaigns} />
          <StatCard title="Total Submissions" value={stats.totalSubmissions} />
          <StatCard title="Pending Review" value={stats.pendingReview} />
          <StatCard title="Rewards Applied" value={stats.rewardsApplied} />
        </InlineGrid>

        {/* Storage bar */}
        <StorageCard usedBytes={storage.usedBytes} tier={storage.tier} />

        <Layout>
          {/* Recent Submissions */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Recent Submissions</Text>
                  <Button size="slim" url="/app/library">View all</Button>
                </InlineStack>
                {recentSubmissions.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No submissions yet. Create a campaign to start collecting content.
                  </Text>
                ) : (
                  <ResourceList
                    items={recentSubmissions}
                    renderItem={(submission: any) => (
                      <ResourceItem
                        id={submission.id}
                        url={`/app/library/${submission.id}`}
                        media={
                          <Thumbnail
                            source={submission.thumbnailUrl || ""}
                            alt={`Submission by ${submission.customer.email}`}
                            size="small"
                          />
                        }
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {submission.customer.email}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {submission.campaign.title}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="300" blockAlign="center">
                            <Badge>{submission.contentType === "VIDEO" ? "Video" : "Photo"}</Badge>
                            {statusBadge(submission.status)}
                          </InlineStack>
                        </InlineStack>
                      </ResourceItem>
                    )}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Active Campaigns Sidebar */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Active Campaigns</Text>
                  <Button size="slim" url="/app/campaigns">View all</Button>
                </InlineStack>
                {activeCampaigns.length === 0 ? (
                  <Text as="p" tone="subdued">No active campaigns.</Text>
                ) : (
                  <BlockStack gap="200">
                    {activeCampaigns.map((campaign: any) => (
                      <a
                        key={campaign.id}
                        href={`/app/campaigns/${campaign.id}`}
                        className="campaign-sidebar-card"
                        style={{
                          textDecoration: "none",
                          color: "inherit",
                          display: "flex",
                          gap: "12px",
                          alignItems: "center",
                          padding: "8px",
                          borderRadius: "10px",
                          transition: "background 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = "var(--p-color-bg-surface-hover)"}
                        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                      >
                        <div style={{
                          width: "56px",
                          height: "56px",
                          minWidth: "56px",
                          borderRadius: "10px",
                          overflow: "hidden",
                          background: "#f3f3f3",
                          position: "relative",
                        }}>
                          {campaign.productImageUrl ? (
                            <img
                              src={campaign.productImageUrl}
                              alt={campaign.productTitle || campaign.title}
                              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                            />
                          ) : (
                            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #f0f0f0, #e0e0e0)", fontSize: "11px", color: "#999" }}>
                              No img
                            </div>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                            <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>{campaign.title}</Text>
                          </div>
                          {campaign.productTitle && (
                            <Text as="p" variant="bodySm" tone="subdued" truncate>{campaign.productTitle}</Text>
                          )}
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
                            <Badge>{campaign.contentType === "VIDEO" ? "Video" : "Photo"}</Badge>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {`${campaign._count.submissions} sub${campaign._count.submissions !== 1 ? "s" : ""} · ${campaign.rewardMonths}mo`}
                            </Text>
                          </div>
                        </div>
                      </a>
                    ))}
                  </BlockStack>
                )}
                <Box paddingBlockStart="200">
                  <Button variant="primary" url="/app/campaigns/new">Create campaign</Button>
                </Box>
              </BlockStack>
            </Card>

            {!shopExists && (
              <Box paddingBlockStart="400">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">Get Started</Text>
                    <Text as="p" variant="bodyMd">
                      Configure your subscription provider and brand settings to start collecting content.
                    </Text>
                    <Button variant="primary" url="/app/settings">Go to Settings</Button>
                  </BlockStack>
                </Card>
              </Box>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
