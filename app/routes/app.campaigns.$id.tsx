import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Box,
  Divider,
  IndexTable,
  Thumbnail,
  Button,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      submissions: {
        include: {
          customer: { select: { email: true } },
          reward: { select: { status: true, months: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      _count: { select: { submissions: true } },
    },
  });

  if (!campaign) {
    throw new Response("Campaign not found", { status: 404 });
  }

  const stats = {
    total: campaign._count.submissions,
    pending: campaign.submissions.filter((s) => s.status === "PENDING").length,
    approved: campaign.submissions.filter((s) => s.status === "APPROVED").length,
    rejected: campaign.submissions.filter((s) => s.status === "REJECTED").length,
  };

  let captureSpecs: Array<{ label: string; description: string }> = [];
  try {
    captureSpecs = JSON.parse(campaign.captureSpecs);
  } catch {
    captureSpecs = [];
  }

  const formatted = {
    id: campaign.id,
    title: campaign.title,
    status: campaign.status,
    moment: campaign.moment,
    rewardMonths: campaign.rewardMonths,
    maxSubmissions: campaign.maxSubmissions,
    captureSpecs,
    startDate: campaign.startDate
      ? new Date(campaign.startDate).toLocaleDateString()
      : null,
    endDate: campaign.endDate
      ? new Date(campaign.endDate).toLocaleDateString()
      : null,
    createdAt: new Date(campaign.createdAt).toLocaleDateString(),
    submissions: campaign.submissions.map((s) => ({
      id: s.id,
      customerEmail: s.customer.email,
      status: s.status,
      contentType: s.contentType,
      contentUrl: s.contentUrl,
      thumbnailUrl: s.thumbnailUrl,
      rewardStatus: s.reward?.status ?? null,
      rewardMonths: s.reward?.months ?? null,
      createdAt: new Date(s.createdAt).toLocaleDateString(),
    })),
  };

  return json({ campaign: formatted, stats });
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

function submissionStatusBadge(status: string) {
  switch (status) {
    case "APPROVED":
      return <Badge tone="success">Approved</Badge>;
    case "PENDING":
      return <Badge tone="attention">Pending</Badge>;
    case "REJECTED":
      return <Badge tone="critical">Rejected</Badge>;
    case "FLAGGED":
      return <Badge tone="warning">Flagged</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function CampaignDetailPage() {
  const { campaign, stats } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <Page
      backAction={{ content: "Campaigns", onAction: () => navigate("/app/campaigns") }}
      title={campaign.title}
      titleMetadata={statusBadge(campaign.status)}
      secondaryActions={[
        {
          content: campaign.status === "ACTIVE" ? "Pause campaign" : "Activate campaign",
          disabled: campaign.status === "CLOSED",
        },
        { content: "Edit campaign" },
      ]}
    >
      <Layout>
        {/* Campaign overview */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Campaign details
              </Text>
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Creative moment</Text>
                  <Text as="span">{campaign.moment}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Reward</Text>
                  <Text as="span">{campaign.rewardMonths} month{campaign.rewardMonths !== 1 ? "s" : ""} free</Text>
                </InlineStack>
                {campaign.maxSubmissions && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Max submissions</Text>
                    <Text as="span">{campaign.maxSubmissions}</Text>
                  </InlineStack>
                )}
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Date range</Text>
                  <Text as="span">
                    {campaign.startDate && campaign.endDate
                      ? `${campaign.startDate} — ${campaign.endDate}`
                      : campaign.startDate
                      ? `From ${campaign.startDate}`
                      : "No dates set"}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Created</Text>
                  <Text as="span">{campaign.createdAt}</Text>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Stats sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Submissions</Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span">Total</Text>
                  <Text as="span" fontWeight="bold">{stats.total}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Pending review</Text>
                  <Text as="span" fontWeight="bold" tone={stats.pending > 0 ? "caution" : undefined}>
                    {stats.pending}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Approved</Text>
                  <Text as="span" fontWeight="bold" tone="success">{stats.approved}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span">Rejected</Text>
                  <Text as="span" fontWeight="bold">{stats.rejected}</Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {campaign.captureSpecs.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Capture specs</Text>
                  <Divider />
                  {campaign.captureSpecs.map((spec: { label: string; description: string }, i: number) => (
                    <BlockStack key={i} gap="100">
                      <Text as="span" fontWeight="semibold">{spec.label}</Text>
                      <Text as="span" tone="subdued">{spec.description}</Text>
                    </BlockStack>
                  ))}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        {/* Submissions table */}
        <Layout.Section>
          {stats.pending > 0 && (
            <Box paddingBlockEnd="400">
              <Banner tone="warning">
                You have {stats.pending} submission{stats.pending !== 1 ? "s" : ""} awaiting review.
              </Banner>
            </Box>
          )}
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "submission", plural: "submissions" }}
              itemCount={campaign.submissions.length}
              headings={[
                { title: "Customer" },
                { title: "Type" },
                { title: "Status" },
                { title: "Reward" },
                { title: "Submitted" },
              ]}
              selectable={false}
            >
              {campaign.submissions.map((submission, index) => (
                <IndexTable.Row
                  id={submission.id}
                  key={submission.id}
                  position={index}
                  onClick={() => navigate(`/app/submissions/${submission.id}`)}
                >
                  <IndexTable.Cell>
                    <Text variant="bodyMd" fontWeight="bold" as="span">
                      {submission.customerEmail}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge>{submission.contentType === "VIDEO" ? "Video" : "Photo"}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {submissionStatusBadge(submission.status)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {submission.rewardStatus ? (
                      <Text as="span">
                        {submission.rewardMonths} mo —{" "}
                        {submission.rewardStatus === "APPLIED" ? (
                          <Badge tone="success">Applied</Badge>
                        ) : submission.rewardStatus === "FAILED" ? (
                          <Badge tone="critical">Failed</Badge>
                        ) : (
                          <Badge>Pending</Badge>
                        )}
                      </Text>
                    ) : (
                      <Text as="span" tone="subdued">—</Text>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">{submission.createdAt}</Text>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
