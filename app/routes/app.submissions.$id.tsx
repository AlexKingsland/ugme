import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
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
  Button,
  Banner,
  TextField,
  MediaCard,
  VideoThumbnail,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;

  const submission = await prisma.submission.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          email: true,
          subscriptionStatus: true,
          shopifyCustomerId: true,
        },
      },
      campaign: {
        select: { title: true, rewardMonths: true, moment: true },
      },
      reward: true,
    },
  });

  if (!submission) {
    throw new Response("Submission not found", { status: 404 });
  }

  return json({
    submission: {
      id: submission.id,
      status: submission.status,
      contentType: submission.contentType,
      contentUrl: submission.contentUrl,
      thumbnailUrl: submission.thumbnailUrl,
      reviewNote: submission.reviewNote,
      reviewedAt: submission.reviewedAt
        ? new Date(submission.reviewedAt).toLocaleDateString()
        : null,
      createdAt: new Date(submission.createdAt).toLocaleDateString(),
      customer: {
        email: submission.customer.email,
        subscriptionStatus: submission.customer.subscriptionStatus,
        shopifyCustomerId: submission.customer.shopifyCustomerId,
      },
      campaign: {
        title: submission.campaign.title,
        rewardMonths: submission.campaign.rewardMonths,
        moment: submission.campaign.moment,
      },
      reward: submission.reward
        ? {
            status: submission.reward.status,
            months: submission.reward.months,
            appliedAt: submission.reward.appliedAt
              ? new Date(submission.reward.appliedAt).toLocaleDateString()
              : null,
          }
        : null,
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;
  const formData = await request.formData();
  const action = formData.get("action") as string;
  const reviewNote = formData.get("reviewNote") as string;

  if (action === "approve") {
    await prisma.submission.update({
      where: { id },
      data: {
        status: "APPROVED",
        reviewNote: reviewNote || null,
        reviewedAt: new Date(),
      },
    });

    // In real app: trigger reward creation here
    const submission = await prisma.submission.findUnique({
      where: { id },
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
  } else if (action === "reject") {
    await prisma.submission.update({
      where: { id },
      data: {
        status: "REJECTED",
        reviewNote: reviewNote || null,
        reviewedAt: new Date(),
      },
    });
  }

  return json({ success: true });
};

function submissionStatusBadge(status: string) {
  switch (status) {
    case "APPROVED":
      return <Badge tone="success">Approved</Badge>;
    case "PENDING":
      return <Badge tone="attention">Pending review</Badge>;
    case "REJECTED":
      return <Badge tone="critical">Rejected</Badge>;
    case "FLAGGED":
      return <Badge tone="warning">Flagged</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function SubmissionDetailPage() {
  const { submission } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [reviewNote, setReviewNote] = useState(submission.reviewNote || "");

  const isPending = submission.status === "PENDING";

  const handleAction = (action: string) => {
    const formData = new FormData();
    formData.set("action", action);
    formData.set("reviewNote", reviewNote);
    submit(formData, { method: "post" });
  };

  return (
    <Page
      backAction={{
        content: "Submissions",
        onAction: () => navigate("/app/submissions"),
      }}
      title={`Submission from ${submission.customer.email}`}
      titleMetadata={submissionStatusBadge(submission.status)}
    >
      <Layout>
        {/* Content preview */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {submission.contentType === "VIDEO" ? "Video" : "Photo"} submission
              </Text>
              <Box
                background="bg-surface-secondary"
                padding="800"
                borderRadius="200"
              >
                {submission.contentType === "VIDEO" ? (
                  <BlockStack gap="200" inlineAlign="center">
                    {submission.thumbnailUrl ? (
                      <img
                        src={submission.thumbnailUrl}
                        alt="Video thumbnail"
                        style={{ maxWidth: "100%", borderRadius: "8px" }}
                      />
                    ) : (
                      <Text as="p" alignment="center" tone="subdued">
                        Video preview not available
                      </Text>
                    )}
                    <Text as="p" alignment="center" tone="subdued">
                      {submission.contentUrl}
                    </Text>
                  </BlockStack>
                ) : (
                  <BlockStack inlineAlign="center">
                    <img
                      src={submission.contentUrl}
                      alt="Submission photo"
                      style={{ maxWidth: "100%", maxHeight: "400px", borderRadius: "8px" }}
                    />
                  </BlockStack>
                )}
              </Box>
            </BlockStack>
          </Card>

          {/* Review actions */}
          {isPending && (
            <Box paddingBlockStart="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Review this submission
                  </Text>
                  <TextField
                    label="Review note (optional)"
                    value={reviewNote}
                    onChange={setReviewNote}
                    multiline={3}
                    placeholder="Add a note about your decision..."
                    autoComplete="off"
                  />
                  <InlineStack gap="300">
                    <Button
                      variant="primary"
                      tone="success"
                      onClick={() => handleAction("approve")}
                    >
                      Approve & reward
                    </Button>
                    <Button
                      variant="primary"
                      tone="critical"
                      onClick={() => handleAction("reject")}
                    >
                      Reject
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Box>
          )}

          {!isPending && submission.reviewNote && (
            <Box paddingBlockStart="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Review note</Text>
                  <Text as="p">{submission.reviewNote}</Text>
                  {submission.reviewedAt && (
                    <Text as="p" tone="subdued">
                      Reviewed on {submission.reviewedAt}
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Box>
          )}
        </Layout.Section>

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Customer</Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Email</Text>
                  <Text as="span">{submission.customer.email}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Subscription</Text>
                  <Badge
                    tone={
                      submission.customer.subscriptionStatus === "ACTIVE"
                        ? "success"
                        : undefined
                    }
                  >
                    {submission.customer.subscriptionStatus}
                  </Badge>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Campaign</Text>
                <Divider />
                <Text as="p" fontWeight="semibold">{submission.campaign.title}</Text>
                <Text as="p" tone="subdued">{submission.campaign.moment}</Text>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Reward</Text>
                  <Text as="span">
                    {submission.campaign.rewardMonths} month{submission.campaign.rewardMonths !== 1 ? "s" : ""} free
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {submission.reward && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Reward</Text>
                  <Divider />
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Status</Text>
                    <Badge
                      tone={
                        submission.reward.status === "APPLIED"
                          ? "success"
                          : submission.reward.status === "FAILED"
                          ? "critical"
                          : undefined
                      }
                    >
                      {submission.reward.status}
                    </Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Months</Text>
                    <Text as="span">{submission.reward.months}</Text>
                  </InlineStack>
                  {submission.reward.appliedAt && (
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">Applied</Text>
                      <Text as="span">{submission.reward.appliedAt}</Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Details</Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Type</Text>
                  <Text as="span">{submission.contentType}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Submitted</Text>
                  <Text as="span">{submission.createdAt}</Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
