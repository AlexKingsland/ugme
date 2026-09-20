import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Tabs,
  EmptyState,
  InlineStack,
  BlockStack,
  Box,
  Button,
  Divider,
  Banner,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  XCircleIcon,
  ViewIcon,
} from "@shopify/polaris-icons";
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
    return json({
      submissions: [],
      counts: { all: 0, pending: 0, approved: 0, rejected: 0 },
    });
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
      customer: {
        select: { email: true },
      },
      campaign: { select: { title: true, rewardMonths: true } },
      reward: { select: { status: true, months: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get counts
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
    customerName: s.customer.email,
    campaignTitle: s.campaign.title,
    rewardMonths: s.campaign.rewardMonths,
    status: s.status,
    contentType: s.contentType,
    contentUrl: s.contentUrl,
    thumbnailUrl: s.thumbnailUrl,
    rewardStatus: s.reward?.status ?? null,
    createdAt: new Date(s.createdAt).toLocaleDateString(),
  }));

  return json({ submissions: formatted, counts });
};

// Quick approve/reject from the list
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const submissionId = formData.get("submissionId") as string;
  const intent = formData.get("intent") as string;

  if (intent === "approve") {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { campaign: true },
    });
    if (submission) {
      await prisma.reward.create({
        data: {
          submissionId: submission.id,
          customerId: submission.customerId,
          months: submission.campaign.rewardMonths,
          discountProvider: "SHOPIFY_NATIVE",
          status: "CREATED",
        },
      });
    }
  } else if (intent === "reject") {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: "REJECTED", reviewedAt: new Date() },
    });
  }

  return json({ ok: true });
};

function statusBadge(status: string) {
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

// ── Submission card component ─────────────────────────────────
function SubmissionCard({
  submission,
  onNavigate,
  onQuickAction,
}: {
  submission: any;
  onNavigate: (id: string) => void;
  onQuickAction: (id: string, action: string) => void;
}) {
  const isPending = submission.status === "PENDING";

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start">
          <InlineStack gap="300" blockAlign="center">
            {/* Thumbnail */}
            <div
              onClick={() => onNavigate(submission.id)}
              style={{
                width: "80px",
                height: "80px",
                borderRadius: "10px",
                background: submission.thumbnailUrl
                  ? `url(${submission.thumbnailUrl}) center/cover`
                  : "#f0f0f0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: "24px",
                color: "#999",
                border: "1px solid #e5e5e5",
                flexShrink: 0,
              }}
            >
              {!submission.thumbnailUrl &&
                (submission.contentType === "VIDEO" ? "▶" : "📷")}
            </div>

            <BlockStack gap="100">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {submission.customerName}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {submission.campaignTitle}
              </Text>
              <InlineStack gap="200">
                {statusBadge(submission.status)}
                <Badge>
                  {submission.contentType === "VIDEO" ? "Video" : "Photo"}
                </Badge>
              </InlineStack>
            </BlockStack>
          </InlineStack>

          <BlockStack gap="100" align="end">
            <Text as="span" variant="bodySm" tone="subdued">
              {submission.createdAt}
            </Text>
            {submission.rewardStatus && (
              <Badge
                tone={
                  submission.rewardStatus === "APPLIED" ? "success" : undefined
                }
              >
                {submission.rewardStatus === "APPLIED"
                  ? "Reward applied"
                  : "Reward pending"}
              </Badge>
            )}
          </BlockStack>
        </InlineStack>

        {/* Quick actions for pending */}
        {isPending && (
          <>
            <Divider />
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm" tone="subdued">
                {submission.rewardMonths} month
                {submission.rewardMonths !== 1 ? "s" : ""} free on approval
              </Text>
              <InlineStack gap="200">
                <Button
                  icon={CheckCircleIcon}
                  tone="success"
                  onClick={() => onQuickAction(submission.id, "approve")}
                  size="slim"
                >
                  Approve
                </Button>
                <Button
                  icon={XCircleIcon}
                  tone="critical"
                  onClick={() => onQuickAction(submission.id, "reject")}
                  size="slim"
                >
                  Reject
                </Button>
                <Button
                  icon={ViewIcon}
                  variant="plain"
                  onClick={() => onNavigate(submission.id)}
                  size="slim"
                >
                  Review
                </Button>
              </InlineStack>
            </InlineStack>
          </>
        )}

        {!isPending && (
          <>
            <Divider />
            <InlineStack align="end">
              <Button
                variant="plain"
                onClick={() => onNavigate(submission.id)}
                size="slim"
              >
                View details →
              </Button>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// ── Main component ──────────────────────────────────────────────
export default function SubmissionsPage() {
  const { submissions, counts } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submitForm = useSubmit();
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
    [setSearchParams]
  );

  const handleQuickAction = useCallback(
    (submissionId: string, intent: string) => {
      const formData = new FormData();
      formData.set("submissionId", submissionId);
      formData.set("intent", intent);
      submitForm(formData, { method: "post" });
    },
    [submitForm]
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

  return (
    <Page title="Submissions">
      <BlockStack gap="400">
        {/* Pending alert */}
        {counts.pending > 0 && currentStatus !== "PENDING" && (
          <Banner
            tone="warning"
            action={{
              content: `Review ${counts.pending} pending`,
              onAction: () => setSearchParams({ status: "PENDING" }),
            }}
          >
            You have {counts.pending} submission
            {counts.pending !== 1 ? "s" : ""} awaiting review.
          </Banner>
        )}

        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange}>
            <Box padding="400">
              {submissions.length === 0 ? (
                <Box padding="800">
                  <Text as="p" alignment="center" tone="subdued">
                    No submissions match this filter.
                  </Text>
                </Box>
              ) : (
                <BlockStack gap="400">
                  {submissions.map((submission) => (
                    <SubmissionCard
                      key={submission.id}
                      submission={submission}
                      onNavigate={(id) => navigate(`/app/submissions/${id}`)}
                      onQuickAction={handleQuickAction}
                    />
                  ))}
                </BlockStack>
              )}
            </Box>
          </Tabs>
        </Card>
      </BlockStack>
    </Page>
  );
}
