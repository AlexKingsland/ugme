import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  Filters,
  ChoiceList,
  Tabs,
  EmptyState,
  Thumbnail,
  InlineStack,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return json({ submissions: [], counts: { all: 0, pending: 0, approved: 0, rejected: 0 } });
  }

  const where: any = {
    campaign: { shopId: shop.id },
  };
  if (statusFilter && statusFilter !== "ALL") {
    where.status = statusFilter;
  }

  const submissions = await prisma.submission.findMany({
    where,
    include: {
      customer: { select: { email: true } },
      campaign: { select: { title: true } },
      reward: { select: { status: true, months: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get counts for each status
  const allSubmissions = await prisma.submission.findMany({
    where: { campaign: { shopId: shop.id } },
    select: { status: true },
  });

  const counts = {
    all: allSubmissions.length,
    pending: allSubmissions.filter((s) => s.status === "PENDING").length,
    approved: allSubmissions.filter((s) => s.status === "APPROVED").length,
    rejected: allSubmissions.filter((s) => s.status === "REJECTED").length,
  };

  const formatted = submissions.map((s) => ({
    id: s.id,
    customerEmail: s.customer.email,
    campaignTitle: s.campaign.title,
    status: s.status,
    contentType: s.contentType,
    contentUrl: s.contentUrl,
    thumbnailUrl: s.thumbnailUrl,
    rewardStatus: s.reward?.status ?? null,
    rewardMonths: s.reward?.months ?? null,
    createdAt: new Date(s.createdAt).toLocaleDateString(),
  }));

  return json({ submissions: formatted, counts });
};

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

export default function SubmissionsPage() {
  const { submissions, counts } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const currentStatus = searchParams.get("status") || "ALL";

  const tabs = [
    { id: "ALL", content: `All (${counts.all})` },
    { id: "PENDING", content: `Pending (${counts.pending})` },
    { id: "APPROVED", content: `Approved (${counts.approved})` },
    { id: "REJECTED", content: `Rejected (${counts.rejected})` },
  ];

  const selectedTab = tabs.findIndex((t) => t.id === currentStatus);

  const handleTabChange = useCallback(
    (index: number) => {
      const status = tabs[index].id;
      if (status === "ALL") {
        setSearchParams({});
      } else {
        setSearchParams({ status });
      }
    },
    [setSearchParams],
  );

  if (counts.all === 0) {
    return (
      <Page title="Submissions">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="No submissions yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  When customers submit content to your campaigns, their
                  submissions will appear here for review.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const rowMarkup = submissions.map((submission, index) => (
    <IndexTable.Row
      id={submission.id}
      key={submission.id}
      position={index}
      onClick={() => navigate(`/app/submissions/${submission.id}`)}
    >
      <IndexTable.Cell>
        <InlineStack gap="300" blockAlign="center">
          {submission.thumbnailUrl && (
            <Thumbnail
              source={submission.thumbnailUrl}
              alt={`Submission from ${submission.customerEmail}`}
              size="small"
            />
          )}
          <Text variant="bodyMd" fontWeight="bold" as="span">
            {submission.customerEmail}
          </Text>
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span">{submission.campaignTitle}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge>{submission.contentType === "VIDEO" ? "Video" : "Photo"}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {submissionStatusBadge(submission.status)}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {submission.rewardStatus ? (
          submission.rewardStatus === "APPLIED" ? (
            <Badge tone="success">{`${submission.rewardMonths} mo applied`}</Badge>
          ) : (
            <Badge>{`${submission.rewardMonths} mo pending`}</Badge>
          )
        ) : (
          <Text as="span" tone="subdued">—</Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">{submission.createdAt}</Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page title="Submissions">
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange}>
              <IndexTable
                resourceName={{ singular: "submission", plural: "submissions" }}
                itemCount={submissions.length}
                headings={[
                  { title: "Customer" },
                  { title: "Campaign" },
                  { title: "Type" },
                  { title: "Status" },
                  { title: "Reward" },
                  { title: "Submitted" },
                ]}
                selectable={false}
              >
                {rowMarkup}
              </IndexTable>
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
