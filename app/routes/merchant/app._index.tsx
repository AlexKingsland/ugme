import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { SubmissionThumbnail } from "../../components/SubmissionThumbnail";
import { extractKeyFromContentUrl, getPresignedDownloadUrl } from "../../utils/r2.server";
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
  Box,
  InlineGrid,
  Divider,
  Banner,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

import {
  getPlan,
  checkStorageLimit,
  checkSubmissionLimit,
  type PlanTierKey,
} from "../../utils/plans.server";
import { formatBytes } from "../../utils/format";

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
      storage: { usedBytes: 0, plan: getPlan("FREE") },
      submissions: { monthlyCount: 0, plan: getPlan("FREE") },
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

  const rawRecentSubmissions = await prisma.submission.findMany({
    where: { campaign: { shopId: shop.id } },
    include: {
      customer: { select: { email: true } },
      campaign: { select: { title: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  // Resolve R2 URLs to presigned download URLs for thumbnails
  const recentSubmissions = await Promise.all(
    rawRecentSubmissions.map(async (s) => {
      let resolvedUrl = s.contentUrl;
      const r2Key = extractKeyFromContentUrl(s.contentUrl);
      if (r2Key && r2Key !== "pending") {
        try {
          resolvedUrl = await getPresignedDownloadUrl(r2Key);
        } catch {
          resolvedUrl = s.contentUrl;
        }
      }
      return { ...s, contentUrl: resolvedUrl };
    }),
  );

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id, status: "ACTIVE" },
    select: {
      id: true,
      title: true,
      rewardCycles: true, rewardFrequency: true,
      productTitle: true,
      productImageUrl: true,
      contentType: true,
      _count: { select: { submissions: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  // Monthly submission count for the current billing period
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthlySubmissions = await prisma.submission.count({
    where: {
      campaign: { shopId: shop.id },
      createdAt: { gte: monthStart },
    },
  });

  const plan = getPlan((shop.planTier as PlanTierKey) || "FREE");

  return json({
    stats: { activeCampaigns, totalSubmissions, pendingReview, rewardsApplied },
    recentSubmissions,
    activeCampaigns: campaigns,
    shopExists: true,
    providerConnected: shop.providerConnected,
    storage: {
      usedBytes: storageAgg._sum.fileBytes || 0,
      plan,
    },
    submissions: {
      monthlyCount: monthlySubmissions,
      plan,
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

function StorageCard({ usedBytes, plan }: { usedBytes: number; plan: { storageBytes: number; storageLabel: string; name: string } }) {
  const pct = plan.storageBytes === Infinity ? 0 : Math.min((usedBytes / plan.storageBytes) * 100, 100);
  const isHigh = pct >= 80;
  const isCritical = pct >= 95;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Storage</Text>
          <Badge tone={isCritical ? "critical" : isHigh ? "attention" : "info"}>{`${plan.name} plan`}</Badge>
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
            {plan.storageLabel} limit
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

function SubmissionsCard({ monthlyCount, plan }: { monthlyCount: number; plan: { submissionsPerMonth: number; submissionLabel: string; name: string } }) {
  const pct = plan.submissionsPerMonth === Infinity ? 0 : Math.min((monthlyCount / plan.submissionsPerMonth) * 100, 100);
  const isHigh = pct >= 80;
  const isCritical = pct >= 95;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Monthly Submissions</Text>
          <Badge tone={isCritical ? "critical" : isHigh ? "attention" : "info"}>{`${plan.name} plan`}</Badge>
        </InlineStack>

        <ProgressBar
          progress={pct}
          tone={isCritical ? "critical" : isHigh ? "highlight" : "primary"}
          size="small"
        />

        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            {monthlyCount} used this month
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {plan.submissionLabel} limit
          </Text>
        </InlineStack>

        {isHigh && (
          <Banner tone={isCritical ? "critical" : "warning"}>
            {isCritical
              ? "You\u2019re almost at your monthly submission limit. Upgrade to keep accepting submissions."
              : "Submission usage is getting high. Consider upgrading to avoid disruptions."}
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
  const { stats, recentSubmissions, activeCampaigns, shopExists, providerConnected, storage, submissions } =
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

        {/* Storage & submissions bars */}
        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <StorageCard usedBytes={storage.usedBytes} plan={storage.plan} />
          {submissions && <SubmissionsCard monthlyCount={submissions.monthlyCount} plan={submissions.plan} />}
        </InlineGrid>

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
                          <SubmissionThumbnail
                            contentType={submission.contentType}
                            contentUrl={submission.contentUrl}
                            durationSecs={submission.durationSecs}
                            size={40}
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
                              {`${campaign._count.submissions} sub${campaign._count.submissions !== 1 ? "s" : ""} · ${campaign.rewardCycles}${campaign.rewardFrequency === "DAY" ? "d" : campaign.rewardFrequency === "WEEK" ? "wk" : "mo"}`}
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
