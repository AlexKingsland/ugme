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
  ProgressBar,
  Icon,
  Tooltip,
} from "@shopify/polaris";
import {
  ClipboardIcon,
  EditIcon,
  PauseCircleIcon,
  PlayIcon,
  ViewIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
} from "@shopify/polaris-icons";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

// ── Loader ──────────────────────────────────────────────────────
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      shop: { select: { shopDomain: true } },
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

  const total = campaign._count.submissions;
  const pending = campaign.submissions.filter((s) => s.status === "PENDING").length;
  const approved = campaign.submissions.filter((s) => s.status === "APPROVED").length;
  const rejected = campaign.submissions.filter((s) => s.status === "REJECTED").length;
  const reviewed = approved + rejected;
  const approvalRate = reviewed > 0 ? Math.round((approved / reviewed) * 100) : 0;

  // Days remaining
  let daysRemaining: number | null = null;
  if (campaign.endDate) {
    const diff = new Date(campaign.endDate).getTime() - Date.now();
    daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  // Budget estimate (approved × rewardMonths × estimated cost-per-month)
  const estimatedCostPerMonth = 30; // placeholder
  const budgetSpent = approved * campaign.rewardMonths * estimatedCostPerMonth;
  const budgetCap = campaign.maxSubmissions
    ? campaign.maxSubmissions * campaign.rewardMonths * estimatedCostPerMonth
    : null;

  let captureSpecs: Array<{ label: string; description: string }> = [];
  try {
    captureSpecs = JSON.parse(campaign.captureSpecs);
  } catch {
    captureSpecs = [];
  }

  const submitUrl = `${new URL(request.url).origin}/submit/${campaign.id}`;

  return json({
    campaign: {
      id: campaign.id,
      title: campaign.title,
      status: campaign.status,
      contentType: campaign.contentType || "VIDEO",
      moment: campaign.moment,
      context: campaign.context,
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
    },
    stats: {
      total,
      pending,
      approved,
      rejected,
      approvalRate,
      daysRemaining,
      budgetSpent,
      budgetCap,
    },
    submissions: campaign.submissions.map((s) => ({
      id: s.id,
      customerEmail: s.customer.email,
      customerName: s.customer.email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
      status: s.status,
      contentType: s.contentType,
      contentUrl: s.contentUrl,
      thumbnailUrl: s.thumbnailUrl,
      rewardStatus: s.reward?.status ?? null,
      rewardMonths: s.reward?.months ?? null,
      createdAt: new Date(s.createdAt).toLocaleDateString(),
    })),
    submitUrl,
  });
};

// ── Action (status toggle) ──────────────────────────────────────
export const action = async ({ request, params }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "toggle-status") {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new Response("Not found", { status: 404 });

    const newStatus = campaign.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    await prisma.campaign.update({
      where: { id },
      data: { status: newStatus },
    });
  }

  return json({ ok: true });
};

// ── Helpers ─────────────────────────────────────────────────────
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

// ── Stat card component ─────────────────────────────────────────
function StatCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "success" | "caution" | "critical";
}) {
  return (
    <Box
      padding="400"
      background="bg-surface"
      borderRadius="300"
      borderWidth="025"
      borderColor="border"
      minWidth="140px"
    >
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text
          as="span"
          variant="headingLg"
          fontWeight="bold"
          tone={tone}
        >
          {value}
        </Text>
        {detail && (
          <Text as="span" variant="bodySm" tone="subdued">
            {detail}
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

// ── Main component ──────────────────────────────────────────────
export default function CampaignDashboard() {
  const { campaign, stats, submissions, submitUrl } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(submitUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [submitUrl]);

  const handleToggleStatus = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "toggle-status");
    submit(formData, { method: "post" });
  }, [submit]);

  const pendingSubmissions = submissions.filter((s) => s.status === "PENDING");
  const approvedSubmissions = submissions.filter((s) => s.status === "APPROVED");

  const submissionProgress = campaign.maxSubmissions
    ? Math.round((stats.total / campaign.maxSubmissions) * 100)
    : null;

  return (
    <Page
      backAction={{
        content: "Campaigns",
        onAction: () => navigate("/app/campaigns"),
      }}
      title={campaign.title}
      titleMetadata={statusBadge(campaign.status)}
      secondaryActions={[
        {
          content:
            campaign.status === "ACTIVE"
              ? "Pause campaign"
              : "Activate campaign",
          icon: campaign.status === "ACTIVE" ? PauseCircleIcon : PlayIcon,
          disabled: campaign.status === "CLOSED",
          onAction: handleToggleStatus,
        },
        {
          content: "Edit campaign",
          icon: EditIcon,
          onAction: () => navigate(`/app/campaigns/${campaign.id}/edit`),
        },
        {
          content: "Share link",
          icon: ClipboardIcon,
          onAction: handleCopyLink,
        },
      ]}
    >
      <BlockStack gap="500">
        {/* ── Pending review banner ── */}
        {stats.pending > 0 && (
          <Banner
            tone="warning"
            action={{
              content: `Review ${stats.pending} submission${stats.pending !== 1 ? "s" : ""}`,
              onAction: () => navigate("/app/submissions"),
            }}
          >
            You have {stats.pending} submission
            {stats.pending !== 1 ? "s" : ""} awaiting review.
          </Banner>
        )}

        {/* ── Stats bar ── */}
        <InlineStack gap="400" wrap>
          <StatCard
            label="Submissions"
            value={
              campaign.maxSubmissions
                ? `${stats.total} / ${campaign.maxSubmissions}`
                : `${stats.total}`
            }
            detail={
              submissionProgress !== null
                ? `${submissionProgress}% of cap`
                : undefined
            }
          />
          <StatCard
            label="Approval rate"
            value={stats.approved + stats.rejected > 0 ? `${stats.approvalRate}%` : "—"}
            detail={`${stats.approved} approved, ${stats.rejected} denied`}
            tone={stats.approvalRate >= 70 ? "success" : stats.approvalRate >= 40 ? "caution" : undefined}
          />
          <StatCard
            label="Days remaining"
            value={
              stats.daysRemaining !== null
                ? `${stats.daysRemaining}`
                : "∞"
            }
            detail={
              campaign.endDate ? `Ends ${campaign.endDate}` : "No end date"
            }
            tone={
              stats.daysRemaining !== null && stats.daysRemaining <= 7
                ? "critical"
                : undefined
            }
          />
          <StatCard
            label="Budget spent"
            value={`$${stats.budgetSpent.toLocaleString()}`}
            detail={
              stats.budgetCap
                ? `of $${stats.budgetCap.toLocaleString()} cap`
                : "No cap set"
            }
          />
        </InlineStack>

        {/* ── Submission progress bar (if capped) ── */}
        {submissionProgress !== null && (
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Submission progress
                </Text>
                <Text as="span" variant="bodyMd" tone="subdued">
                  {stats.total} of {campaign.maxSubmissions} submissions
                </Text>
              </InlineStack>
              <ProgressBar
                progress={Math.min(submissionProgress, 100)}
                tone={submissionProgress >= 90 ? "critical" : "primary"}
                size="small"
              />
            </BlockStack>
          </Card>
        )}

        <Layout>
          {/* ── Main column ── */}
          <Layout.Section>
            <BlockStack gap="500">
              {/* Campaign setup summary */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Campaign setup
                    </Text>
                    <Button
                      variant="plain"
                      icon={EditIcon}
                      onClick={() =>
                        navigate(`/app/campaigns/${campaign.id}/edit`)
                      }
                    >
                      Edit
                    </Button>
                  </InlineStack>
                  <Divider />
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Content type
                      </Text>
                      <Badge>
                        {campaign.contentType === "VIDEO" ? "Video" : "Photo"}
                      </Badge>
                    </InlineStack>

                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Reward
                      </Text>
                      <Text as="span" fontWeight="semibold">
                        {campaign.rewardMonths} free month
                        {campaign.rewardMonths !== 1 ? "s" : ""}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Date range
                      </Text>
                      <Text as="span">
                        {campaign.startDate && campaign.endDate
                          ? `${campaign.startDate} — ${campaign.endDate}`
                          : campaign.startDate
                          ? `From ${campaign.startDate}`
                          : "No dates set"}
                      </Text>
                    </InlineStack>
                    {campaign.maxSubmissions && (
                      <InlineStack align="space-between">
                        <Text as="span" tone="subdued">
                          Submission cap
                        </Text>
                        <Text as="span" fontWeight="semibold">
                          {campaign.maxSubmissions}
                        </Text>
                      </InlineStack>
                    )}
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Created
                      </Text>
                      <Text as="span">{campaign.createdAt}</Text>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Creative brief */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Creative brief
                  </Text>
                  <Divider />

                  {/* Creative moment */}
                  {campaign.moment && (
                    <Box
                      padding="400"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <BlockStack gap="200">
                        <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                          Creative moment
                        </Text>
                        <Text as="p" variant="bodyMd">
                          {campaign.moment}
                        </Text>
                      </BlockStack>
                    </Box>
                  )}

                  {/* Content requirements */}
                  {campaign.captureSpecs.filter(
                    (s: { label: string }) => s.label === "Requirement"
                  ).length > 0 && (
                    <BlockStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                        Content requirements
                      </Text>
                      <BlockStack gap="0">
                        {campaign.captureSpecs
                          .filter((s: { label: string }) => s.label === "Requirement")
                          .map((spec: { label: string; description: string }, i: number) => (
                            <div
                              key={i}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "10px",
                                padding: "8px 12px",
                                background: i % 2 === 0 ? "var(--p-color-bg-surface-secondary)" : "transparent",
                                borderRadius: "6px",
                              }}
                            >
                              <span style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: "20px",
                                height: "20px",
                                minWidth: "20px",
                                borderRadius: "6px",
                                background: "var(--p-color-bg-surface-tertiary)",
                                color: "var(--p-color-text-subdued)",
                                fontSize: "11px",
                                fontWeight: 600,
                                marginTop: "1px",
                              }}>
                                {i + 1}
                              </span>
                              <Text as="span" variant="bodyMd">
                                {spec.description}
                              </Text>
                            </div>
                          ))}
                      </BlockStack>
                    </BlockStack>
                  )}

                  {/* Technical specs */}
                  {campaign.captureSpecs.filter(
                    (s: { label: string }) => s.label !== "Requirement"
                  ).length > 0 && (
                    <BlockStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">
                        Technical specs
                      </Text>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                          gap: "8px",
                        }}
                      >
                        {campaign.captureSpecs
                          .filter((s: { label: string }) => s.label !== "Requirement")
                          .map((spec: { label: string; description: string }, i: number) => (
                            <div
                              key={i}
                              style={{
                                padding: "10px 12px",
                                background: "var(--p-color-bg-surface-secondary)",
                                borderRadius: "8px",
                              }}
                            >
                              <div style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", marginBottom: "2px" }}>
                                {spec.label}
                              </div>
                              <div style={{ fontSize: "13px", fontWeight: 600 }}>
                                {spec.description}
                              </div>
                            </div>
                          ))}
                      </div>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Recent submissions */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Recent submissions
                    </Text>
                    {submissions.length > 0 && (
                      <Button
                        variant="plain"
                        onClick={() => navigate("/app/submissions")}
                      >
                        View all →
                      </Button>
                    )}
                  </InlineStack>
                  <Divider />
                  {submissions.length === 0 ? (
                    <Box padding="400">
                      <BlockStack gap="200" align="center">
                        <Text
                          as="p"
                          variant="bodyMd"
                          tone="subdued"
                          alignment="center"
                        >
                          No submissions yet. Share your campaign link to get
                          started.
                        </Text>
                        <Button onClick={handleCopyLink}>
                          {linkCopied ? "Copied!" : "Copy submission link"}
                        </Button>
                      </BlockStack>
                    </Box>
                  ) : (
                    <BlockStack gap="300">
                      {submissions.slice(0, 5).map((s) => (
                        <Box key={s.id}>
                          <InlineStack
                            align="space-between"
                            blockAlign="center"
                            gap="300"
                          >
                            <InlineStack gap="300" blockAlign="center">
                              {/* Thumbnail placeholder */}
                              <Box
                                minWidth="48px"
                                minHeight="48px"
                                background="bg-surface-secondary"
                                borderRadius="200"
                              >
                                <div
                                  style={{
                                    width: "48px",
                                    height: "48px",
                                    borderRadius: "8px",
                                    background: s.thumbnailUrl
                                      ? `url(${s.thumbnailUrl}) center/cover`
                                      : "#e1e1e1",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "11px",
                                    color: "#666",
                                  }}
                                >
                                  {!s.thumbnailUrl &&
                                    (s.contentType === "VIDEO" ? "▶" : "📷")}
                                </div>
                              </Box>
                              <BlockStack gap="100">
                                <Text
                                  as="span"
                                  variant="bodyMd"
                                  fontWeight="semibold"
                                >
                                  {s.customerName}
                                </Text>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {s.createdAt}
                                </Text>
                              </BlockStack>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center">
                              {submissionStatusBadge(s.status)}
                              <Button
                                variant="plain"
                                icon={ViewIcon}
                                onClick={() =>
                                  navigate(`/app/submissions/${s.id}`)
                                }
                              >
                                Review
                              </Button>
                            </InlineStack>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* ── Sidebar ── */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              {/* Share link card */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Share campaign
                  </Text>
                  <Divider />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Send this link to your subscribers
                  </Text>
                  <Box
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                  >
                    <Text as="p" variant="bodySm" breakWord>
                      {submitUrl}
                    </Text>
                  </Box>
                  <Button
                    fullWidth
                    icon={linkCopied ? CheckCircleIcon : ClipboardIcon}
                    onClick={handleCopyLink}
                    variant={linkCopied ? "primary" : undefined}
                  >
                    {linkCopied ? "Copied!" : "Copy link"}
                  </Button>
                  <Button
                    fullWidth
                    variant="plain"
                    onClick={() =>
                      navigate(`/app/campaigns/${campaign.id}/live`)
                    }
                  >
                    More sharing options →
                  </Button>
                </BlockStack>
              </Card>

              {/* Approved content preview */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Approved content
                    </Text>
                    <Badge tone="success">{stats.approved}</Badge>
                  </InlineStack>
                  <Divider />
                  {approvedSubmissions.length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No approved content yet. Submissions will appear here
                      once reviewed.
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {/* Thumbnail grid for approved content */}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(3, 1fr)",
                          gap: "8px",
                        }}
                      >
                        {approvedSubmissions.slice(0, 6).map((s) => (
                          <div
                            key={s.id}
                            onClick={() =>
                              navigate(`/app/submissions/${s.id}`)
                            }
                            style={{
                              aspectRatio: "1",
                              borderRadius: "8px",
                              background: s.thumbnailUrl
                                ? `url(${s.thumbnailUrl}) center/cover`
                                : "#f0f0f0",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: "pointer",
                              fontSize: "18px",
                              color: "#999",
                              border: "1px solid #e1e1e1",
                            }}
                          >
                            {!s.thumbnailUrl &&
                              (s.contentType === "VIDEO" ? "▶" : "📷")}
                          </div>
                        ))}
                      </div>
                      {approvedSubmissions.length > 6 && (
                        <Button
                          variant="plain"
                          fullWidth
                          onClick={() => navigate("/app/submissions")}
                        >
                          View all {approvedSubmissions.length} approved →
                        </Button>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Quick stats breakdown */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Submission breakdown
                  </Text>
                  <Divider />
                  <InlineStack align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={ClockIcon} tone="base" />
                      <Text as="span">Pending</Text>
                    </InlineStack>
                    <Text as="span" fontWeight="bold">
                      {stats.pending}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={CheckCircleIcon} tone="success" />
                      <Text as="span">Approved</Text>
                    </InlineStack>
                    <Text as="span" fontWeight="bold" tone="success">
                      {stats.approved}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon source={XCircleIcon} tone="critical" />
                      <Text as="span">Rejected</Text>
                    </InlineStack>
                    <Text as="span" fontWeight="bold">
                      {stats.rejected}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
