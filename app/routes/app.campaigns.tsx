import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  useIndexResourceState,
  EmptyState,
  Button,
} from "@shopify/polaris";
import type { IndexTableRowProps } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return json({ campaigns: [] });
  }

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    include: {
      _count: {
        select: { submissions: true },
      },
      submissions: {
        where: { status: "PENDING" },
        select: { id: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const formatted = campaigns.map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    moment: c.moment,
    rewardMonths: c.rewardMonths,
    totalSubmissions: c._count.submissions,
    pendingSubmissions: c.submissions.length,
    maxSubmissions: c.maxSubmissions,
    startDate: c.startDate ? new Date(c.startDate).toLocaleDateString() : null,
    endDate: c.endDate ? new Date(c.endDate).toLocaleDateString() : null,
    createdAt: new Date(c.createdAt).toLocaleDateString(),
  }));

  return json({ campaigns: formatted });
};

function statusBadge(status: string) {
  switch (status) {
    case "ACTIVE":
      return <Badge tone="success">Active</Badge>;
    case "DRAFT":
      return <Badge>Draft</Badge>;
    case "PAUSED":
      return <Badge tone="warning">Paused</Badge>;
    case "CLOSED":
      return <Badge tone="info">Closed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function CampaignsPage() {
  const { campaigns } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const resourceName = {
    singular: "campaign",
    plural: "campaigns",
  };

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(campaigns);

  if (campaigns.length === 0) {
    return (
      <Page title="Campaigns">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Create your first campaign"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Campaigns let you collect customer-generated content from your
                  subscribers. Define a creative moment, set reward terms, and
                  invite customers to participate.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const rowMarkup = campaigns.map((campaign, index) => (
    <IndexTable.Row
      id={campaign.id}
      key={campaign.id}
      selected={selectedResources.includes(campaign.id)}
      position={index}
      onClick={() => navigate(`/app/campaigns/${campaign.id}`)}
    >
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">
          {campaign.title}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{statusBadge(campaign.status)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" alignment="center" numeric>
          {campaign.totalSubmissions}
          {campaign.maxSubmissions ? ` / ${campaign.maxSubmissions}` : ""}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {campaign.pendingSubmissions > 0 ? (
          <Badge tone="attention">{`${campaign.pendingSubmissions} pending`}</Badge>
        ) : (
          <Text as="span" tone="subdued">
            None
          </Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span">{campaign.rewardMonths} mo free</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">
          {campaign.createdAt}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Campaigns"
      primaryAction={
        <Button variant="primary" onClick={() => navigate("/app/campaigns/new")}>
          Create campaign
        </Button>
      }
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={resourceName}
              itemCount={campaigns.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Campaign" },
                { title: "Status" },
                { title: "Submissions" },
                { title: "Pending review" },
                { title: "Reward" },
                { title: "Created" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
