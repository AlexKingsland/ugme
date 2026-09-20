import { json } from "@remix-run/node";
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
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  XCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
} from "@shopify/polaris-icons";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
        select: { id: true, title: true, rewardMonths: true, moment: true, captureSpecs: true },
      },
      reward: true,
    },
  });

  if (!submission) {
    throw new Response("Submission not found", { status: 404 });
  }

  // Find adjacent submissions for prev/next navigation
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  let prevId: string | null = null;
  let nextId: string | null = null;

  if (shop) {
    const allSubmissions = await prisma.submission.findMany({
      where: { campaign: { shopId: shop.id } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    const currentIndex = allSubmissions.findIndex((s) => s.id === id);
    if (currentIndex > 0) prevId = allSubmissions[currentIndex - 1].id;
    if (currentIndex < allSubmissions.length - 1)
      nextId = allSubmissions[currentIndex + 1].id;
  }

  let captureSpecs: Array<{ label: string; description: string }> = [];
  try {
    captureSpecs = JSON.parse(submission.campaign.captureSpecs);
  } catch {
    captureSpecs = [];
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
        name:
          submission.customer.email,
        subscriptionStatus: submission.customer.subscriptionStatus,
        shopifyCustomerId: submission.customer.shopifyCustomerId,
      },
      campaign: {
        id: submission.campaign.id,
        title: submission.campaign.title,
        rewardMonths: submission.campaign.rewardMonths,
        moment: submission.campaign.moment,
        captureSpecs,
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
    prevId,
    nextId,
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
  const { submission, prevId, nextId } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [reviewNote, setReviewNote] = useState(submission.reviewNote || "");

  const isPending = submission.status === "PENDING";

  const handleAction = useCallback(
    (action: string) => {
      const formData = new FormData();
      formData.set("action", action);
      formData.set("reviewNote", reviewNote);
      submit(formData, { method: "post" });
    },
    [reviewNote, submit]
  );

  return (
    <Page
      backAction={{
        content: "Submissions",
        onAction: () => navigate("/app/submissions"),
      }}
      title={`Submission from ${submission.customer.name}`}
      titleMetadata={submissionStatusBadge(submission.status)}
      secondaryActions={[
        ...(prevId
          ? [
              {
                content: "Previous",
                icon: ArrowLeftIcon,
                onAction: () => navigate(`/app/submissions/${prevId}`),
              },
            ]
          : []),
        ...(nextId
          ? [
              {
                content: "Next",
                icon: ArrowRightIcon,
                onAction: () => navigate(`/app/submissions/${nextId}`),
              },
            ]
          : []),
      ]}
    >
      <Layout>
        {/* ── Content preview (main area) ── */}
        <Layout.Section>
          <BlockStack gap="400">
            {/* Large content preview */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {submission.contentType === "VIDEO"
                      ? "Video"
                      : "Photo"}{" "}
                    submission
                  </Text>
                  <Badge>
                    {submission.contentType === "VIDEO" ? "Video" : "Photo"}
                  </Badge>
                </InlineStack>

                {/* Content viewer */}
                <Box borderRadius="300" overflow="hidden">
                  <div
                    style={{
                      background: "#1a1a1a",
                      borderRadius: "12px",
                      overflow: "hidden",
                      position: "relative",
                    }}
                  >
                    {submission.contentType === "VIDEO" ? (
                      submission.contentUrl ? (
                        <video
                          src={submission.contentUrl}
                          controls
                          poster={submission.thumbnailUrl || undefined}
                          style={{
                            width: "100%",
                            maxHeight: "500px",
                            display: "block",
                          }}
                        />
                      ) : submission.thumbnailUrl ? (
                        <img
                          src={submission.thumbnailUrl}
                          alt="Video thumbnail"
                          style={{
                            width: "100%",
                            maxHeight: "500px",
                            objectFit: "contain",
                            display: "block",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            height: "400px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Text as="p" tone="subdued">
                            Video preview not available
                          </Text>
                        </div>
                      )
                    ) : submission.contentUrl ? (
                      <img
                        src={submission.contentUrl}
                        alt="Submission photo"
                        style={{
                          width: "100%",
                          maxHeight: "500px",
                          objectFit: "contain",
                          display: "block",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          height: "400px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text as="p" tone="subdued">
                          Photo not available
                        </Text>
                      </div>
                    )}
                  </div>
                </Box>

                {submission.contentUrl && (
                  <Text as="p" variant="bodySm" tone="subdued" breakWord>
                    {submission.contentUrl}
                  </Text>
                )}
              </BlockStack>
            </Card>

            {/* Review actions (pending only) */}
            {isPending && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Review this submission
                  </Text>
                  <Text as="p" tone="subdued">
                    Approving will grant the customer{" "}
                    {submission.campaign.rewardMonths} free month
                    {submission.campaign.rewardMonths !== 1 ? "s" : ""} on their
                    subscription.
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
                      icon={CheckCircleIcon}
                      onClick={() => handleAction("approve")}
                      size="large"
                    >
                      Approve &amp; reward
                    </Button>
                    <Button
                      tone="critical"
                      icon={XCircleIcon}
                      onClick={() => handleAction("reject")}
                      size="large"
                    >
                      Reject
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {/* Review outcome (already reviewed) */}
            {!isPending && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Review decision
                    </Text>
                    {submissionStatusBadge(submission.status)}
                  </InlineStack>
                  {submission.reviewNote && (
                    <>
                      <Divider />
                      <Text as="p">{submission.reviewNote}</Text>
                    </>
                  )}
                  {submission.reviewedAt && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Reviewed on {submission.reviewedAt}
                    </Text>
                  )}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        {/* ── Sidebar ── */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Customer info */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Customer
                </Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    Name
                  </Text>
                  <Text as="span" fontWeight="semibold">
                    {submission.customer.name}
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    Email
                  </Text>
                  <Text as="span">{submission.customer.email}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    Subscription
                  </Text>
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

            {/* Campaign info */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Campaign
                </Text>
                <Divider />
                <Button
                  variant="plain"
                  onClick={() =>
                    navigate(`/app/campaigns/${submission.campaign.id}`)
                  }
                >
                  {submission.campaign.title} →
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  {submission.campaign.moment}
                </Text>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    Reward
                  </Text>
                  <Text as="span" fontWeight="semibold">
                    {submission.campaign.rewardMonths} month
                    {submission.campaign.rewardMonths !== 1 ? "s" : ""} free
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Capture specs checklist */}
            {submission.campaign.captureSpecs.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Capture specs
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Check the submission against these guidelines:
                  </Text>
                  <Divider />
                  {submission.campaign.captureSpecs.map(
                    (
                      spec: { label: string; description: string },
                      i: number
                    ) => (
                      <InlineStack key={i} gap="200" blockAlign="start">
                        <Box>
                          <div
                            style={{
                              width: "18px",
                              height: "18px",
                              borderRadius: "3px",
                              border: "2px solid #ccc",
                              marginTop: "2px",
                            }}
                          />
                        </Box>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight="semibold">
                            {spec.label}
                          </Text>
                          {spec.description && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {spec.description}
                            </Text>
                          )}
                        </BlockStack>
                      </InlineStack>
                    )
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Reward status */}
            {submission.reward && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Reward
                  </Text>
                  <Divider />
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      Status
                    </Text>
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
                    <Text as="span" tone="subdued">
                      Months
                    </Text>
                    <Text as="span">{submission.reward.months}</Text>
                  </InlineStack>
                  {submission.reward.appliedAt && (
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Applied
                      </Text>
                      <Text as="span">{submission.reward.appliedAt}</Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Submission metadata */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Details
                </Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    Content type
                  </Text>
                  <Badge>
                    {submission.contentType === "VIDEO" ? "Video" : "Photo"}
                  </Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    Submitted
                  </Text>
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
