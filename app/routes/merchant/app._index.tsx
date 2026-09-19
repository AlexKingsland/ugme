import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Box,
  InlineGrid,
  Divider,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findFirst({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    // Return empty state for shops that haven't completed setup
    return json({
      stats: { activeCampaigns: 0, totalSubmissions: 0, pendingReview: 0, rewardsApplied: 0 },
      recentSubmissions: [],
      activeCampaigns: [],
      shopExists: false,
      providerConnected: false,
    });
  }

  const [activeCampaigns, totalSubmissions, pendingReview, rewardsApplied] =
    await Promise.all([
      prisma.campaign.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
      prisma.submission.count({
        where: { campaign: { shopId: shop.id } },
      }),
      prisma.submission.count({
        where: { campaign: { shopId: shop.id }, status: "PENDING" },
      }),
      prisma.reward.count({
        where: { customer: { shopId: shop.id }, status: "APPLIED" },
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
    include: {
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
  });
};

function StatCard({ title, value, helpText }: { title: string; value: number; helpText?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" tone="subdued">
          {title}
        </Text>
        <Text as="p" variant="headingXl">
          {value}
        </Text>
        {helpText && (
          <Text as="p" variant="bodySm" tone="subdued">
            {helpText}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "PENDING":
      return <Badge tone="attention">Pending</Badge>;
    case "APPROVED":
      return <Badge tone="success">Approved</Badge>;
    case "REJECTED":
      return <Badge tone="critical">Rejected</Badge>;
    case "FLAGGED":
      return <Badge tone="warning">Flagged</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function Dashboard() {
  const { stats, recentSubmissions, activeCampaigns, shopExists, providerConnected } =
    useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="UGME Dashboard" />
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
      <BlockStack gap="500">
        {/* Stats Row */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard
            title="Active Campaigns"
            value={stats.activeCampaigns}
          />
          <StatCard
            title="Total Submissions"
            value={stats.totalSubmissions}
          />
          <StatCard
            title="Pending Review"
            value={stats.pendingReview}
          />
          <StatCard
            title="Rewards Applied"
            value={stats.rewardsApplied}
          />
        </InlineGrid>

        <Layout>
          {/* Recent Submissions */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Recent Submissions
                  </Text>
                  <Link to="/app/submissions">View all</Link>
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
                        url={`/app/submissions/${submission.id}`}
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
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Active Campaigns
                  </Text>
                  <Link to="/app/campaigns">View all</Link>
                </InlineStack>
                {activeCampaigns.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No active campaigns.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    {activeCampaigns.map((campaign: any) => (
                      <Box key={campaign.id}>
                        <Link to={`/app/campaigns/${campaign.id}`}>
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {campaign.title}
                            </Text>
                            <InlineStack gap="200">
                              <Text as="span" variant="bodySm" tone="subdued">
                                {campaign._count.submissions} submissions
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                · {campaign.rewardMonths}mo reward
                              </Text>
                            </InlineStack>
                          </BlockStack>
                        </Link>
                        <Box paddingBlockStart="300">
                          <Divider />
                        </Box>
                      </Box>
                    ))}
                  </BlockStack>
                )}

                <Box paddingBlockStart="200">
                  <Link to="/app/campaigns/new">
                    Create campaign
                  </Link>
                </Box>
              </BlockStack>
            </Card>

            {!shopExists && (
              <Box paddingBlockStart="400">
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      Get Started
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Configure your subscription provider and brand settings to start collecting content.
                    </Text>
                    <Link to="/app/settings">Go to Settings</Link>
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
