import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  Box,
  Divider,
  Banner,
  TextField,
  Tag,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

function timeAgo(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatDuration(secs: number | null): string {
  if (!secs) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function formatReward(discountType: string, discountValue: number, months: number): string {
  if (discountType === "FREE") return `${months} month${months !== 1 ? "s" : ""} free`;
  if (discountType === "FIXED_AMOUNT") return `$${discountValue}/mo off for ${months} month${months !== 1 ? "s" : ""}`;
  if (discountType === "PERCENTAGE") return `${discountValue}% off for ${months} month${months !== 1 ? "s" : ""}`;
  return `${months} months`;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return redirect("/app");

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: {
      customer: { select: { email: true } },
      campaign: { select: { id: true, title: true, moment: true, rewardMonths: true, discountType: true, discountValue: true, shopId: true } },
      reward: { select: { status: true, months: true } },
    },
  });

  if (!submission || submission.campaign.shopId !== shop.id || submission.status === "REJECTED") {
    return redirect("/app/library");
  }

  // Find next pending submission in queue
  const nextPending = await prisma.submission.findFirst({
    where: {
      campaign: { shopId: shop.id },
      status: "PENDING",
      id: { not: submission.id },
      createdAt: { gte: submission.createdAt },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  return json({
    submission: {
      id: submission.id,
      email: submission.customer.email,
      displayName: submission.customer.email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
      campaignTitle: submission.campaign.title,
      campaignMoment: submission.campaign.moment,
      contentType: submission.contentType,
      contentUrl: submission.contentUrl,
      thumbnailUrl: submission.thumbnailUrl,
      durationSecs: submission.durationSecs,
      description: submission.description,
      fileBytes: submission.fileBytes,
      status: submission.status,
      createdAt: submission.createdAt,
      reviewedAt: submission.reviewedAt,
      reviewNote: submission.reviewNote,
      rejectionReason: submission.rejectionReason,
      rewardMonths: submission.campaign.rewardMonths,
      discountType: submission.campaign.discountType,
      discountValue: submission.campaign.discountValue,
      rewardStatus: submission.reward?.status || null,
    },
    nextPendingId: nextPending?.id || null,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return json({ error: "Shop not found" }, { status: 400 });

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: { campaign: true },
  });
  if (!submission || submission.campaign.shopId !== shop.id) {
    return json({ error: "Not found" }, { status: 404 });
  }

  if (actionType === "approve") {
    await prisma.submission.update({
      where: { id: params.id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        rightsAccepted: true,
        usageTags: JSON.stringify(["Social + Product Pages"]),
      },
    });
    await prisma.reward.upsert({
      where: { submissionId: params.id! },
      update: { status: "APPLIED", appliedAt: new Date() },
      create: {
        submissionId: params.id!,
        customerId: submission.customerId,
        months: submission.campaign.rewardMonths,
        discountProvider: "SHOPIFY_NATIVE",
        status: "APPLIED",
        appliedAt: new Date(),
      },
    });
    return json({ success: true, action: "approved" });
  }

  if (actionType === "deny") {
    const reason = formData.get("reason") as string;
    const note = formData.get("note") as string;
    await prisma.submission.update({
      where: { id: params.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        rejectionReason: reason || "Does not meet requirements",
        reviewNote: note || null,
      },
    });
    return json({ success: true, action: "denied" });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

const DENY_REASONS = [
  "Product isn't visible",
  "Doesn't show the requested moment",
  "Wrong format",
  "Video is too short",
  "Duplicate submission",
  "Suspected synthetic content",
  "Other",
];

export default function SubmissionDetail() {
  const { submission, nextPendingId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isActing = navigation.state === "submitting";

  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [denyNote, setDenyNote] = useState("");
  const [showDenyPanel, setShowDenyPanel] = useState(false);

  const handleApprove = useCallback(() => {
    const formData = new FormData();
    formData.set("_action", "approve");
    submit(formData, { method: "post" });
  }, [submit]);

  const handleDeny = useCallback(() => {
    const formData = new FormData();
    formData.set("_action", "deny");
    formData.set("reason", selectedReason || "Other");
    formData.set("note", denyNote);
    submit(formData, { method: "post" });
  }, [submit, selectedReason, denyNote]);

  const isPending = submission.status === "PENDING";
  const rewardText = formatReward(submission.discountType, submission.discountValue, submission.rewardMonths);

  return (
    <Page
      backAction={{ content: "Library", url: "/app/library" }}
      title={`Submission from ${submission.displayName}`}
      titleMetadata={
        <Badge tone={isPending ? "attention" : submission.status === "APPROVED" ? "success" : "critical"}>
          {isPending ? "DECIDE" : submission.status}
        </Badge>
      }
      secondaryActions={nextPendingId ? [{ content: "Next in queue ›", url: `/app/library/${nextPendingId}` }] : []}
    >
      {actionData?.success && (
        <Box paddingBlockEnd="400">
          <Banner tone="success">
            {actionData.action === "approved"
              ? `Approved! Reward of ${rewardText} has been issued.`
              : "Submission denied. The customer will be notified."}
          </Banner>
        </Box>
      )}

      <Layout>
        {/* Media preview */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <div style={{
                position: "relative",
                borderRadius: 12,
                overflow: "hidden",
                background: "#1a1a1a",
                aspectRatio: "9/16",
                maxHeight: 560,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                {submission.contentType === "VIDEO" ? (
                  <>
                    <img
                      src={submission.thumbnailUrl || "https://placehold.co/400x600/1a1a1a/666?text=Video"}
                      alt="Video thumbnail"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                    <div style={{
                      position: "absolute", inset: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "rgba(0,0,0,0.3)",
                    }}>
                      <div style={{
                        width: 64, height: 64, borderRadius: "50%",
                        background: "rgba(255,255,255,0.9)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <div style={{
                          width: 0, height: 0,
                          borderTop: "14px solid transparent",
                          borderBottom: "14px solid transparent",
                          borderLeft: "22px solid #1a1a1a",
                          marginLeft: 4,
                        }} />
                      </div>
                    </div>
                    {submission.durationSecs && (
                      <div style={{
                        position: "absolute", bottom: 12, right: 12,
                        background: "rgba(0,0,0,0.7)", color: "#fff",
                        fontSize: 13, fontWeight: 600, padding: "4px 8px", borderRadius: 6,
                      }}>
                        {formatDuration(submission.durationSecs)}
                      </div>
                    )}
                  </>
                ) : (
                  <img
                    src={submission.thumbnailUrl || submission.contentUrl}
                    alt="Submission photo"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                )}
              </div>

              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {submission.contentType === "VIDEO" ? "Video" : "Photo"} · {(submission.fileBytes / (1024 * 1024)).toFixed(1)} MB
                    {submission.durationSecs ? ` · ${formatDuration(submission.durationSecs)}` : ""}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Submitted {timeAgo(submission.createdAt)}
                  </Text>
                </BlockStack>
                <Badge>{submission.campaignTitle}</Badge>
              </InlineStack>

              {submission.description && (
                <>
                  <Divider />
                  <Text as="p" tone="subdued">{submission.description}</Text>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Decision sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Decision card */}
            {isPending ? (
              <>
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Make a decision</Text>
                    <Text as="p" tone="subdued">
                      Approving will schedule {rewardText} on {submission.displayName}'s subscription immediately.
                    </Text>

                    <InlineStack gap="200">
                      <Button
                        variant="primary"
                        tone="success"
                        onClick={handleApprove}
                        loading={isActing}
                      >
                        Approve + issue {rewardText}
                      </Button>
                      <Button
                        tone="critical"
                        onClick={() => setShowDenyPanel(true)}
                        loading={isActing}
                      >
                        Deny
                      </Button>
                    </InlineStack>

                    <Text as="p" variant="bodySm" tone="caution">
                      ⚠ This cannot be undone.
                    </Text>
                  </BlockStack>
                </Card>

                {/* Deny reasons panel */}
                {showDenyPanel && (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingMd">If you deny, why isn't this a match?</Text>
                      <InlineStack gap="200" wrap>
                        {DENY_REASONS.map((reason) => (
                          <Button
                            key={reason}
                            pressed={selectedReason === reason}
                            onClick={() => setSelectedReason(reason)}
                            size="slim"
                          >
                            {reason}
                          </Button>
                        ))}
                      </InlineStack>
                      <TextField
                        label="Optional note for the customer"
                        labelHidden
                        placeholder="Add an optional note for context..."
                        value={denyNote}
                        onChange={setDenyNote}
                        multiline={2}
                        autoComplete="off"
                      />
                      <Text as="p" variant="bodySm" tone="subdued">
                        The customer will see the reason you choose.
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          tone="critical"
                          variant="primary"
                          onClick={handleDeny}
                          disabled={!selectedReason}
                          loading={isActing}
                        >
                          Confirm deny
                        </Button>
                        <Button onClick={() => { setShowDenyPanel(false); setSelectedReason(null); }}>
                          Cancel
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                )}
              </>
            ) : (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Decision</Text>
                  <Divider />
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={submission.status === "APPROVED" ? "success" : "critical"}>
                      {submission.status}
                    </Badge>
                    <Text as="span" tone="subdued">
                      {submission.reviewedAt ? timeAgo(submission.reviewedAt) : ""}
                    </Text>
                  </InlineStack>
                  {submission.status === "APPROVED" && (
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">Reward</Text>
                      <Text as="span" fontWeight="bold">{rewardText}</Text>
                    </InlineStack>
                  )}
                  {submission.rejectionReason && (
                    <>
                      <InlineStack align="space-between">
                        <Text as="span" tone="subdued">Reason</Text>
                        <Text as="span">{submission.rejectionReason}</Text>
                      </InlineStack>
                    </>
                  )}
                  {submission.reviewNote && (
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">Note</Text>
                      <Text as="span">{submission.reviewNote}</Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* Submission info */}
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Details</Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Customer</Text>
                  <Text as="span">{submission.email}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Campaign</Text>
                  <Text as="span">{submission.campaignTitle}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Type</Text>
                  <Text as="span">{submission.contentType === "VIDEO" ? "Video" : "Photo"}</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Size</Text>
                  <Text as="span">{(submission.fileBytes / (1024 * 1024)).toFixed(1)} MB</Text>
                </InlineStack>
                {submission.durationSecs && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Duration</Text>
                    <Text as="span">{formatDuration(submission.durationSecs)}</Text>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
