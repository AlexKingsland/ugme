import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { extractKeyFromContentUrl, getPresignedDownloadUrl, deleteObject } from "../../utils/r2.server";
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
  InlineGrid,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { approveSubmission } from "../../utils/approval.server";
import { mediaUrlsFor } from "../../utils/submission-media.server";
import { checkSubmissionLimit, type PlanTierKey } from "../../utils/plans.server";

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




import { campaignRewardLabel } from "../../utils/rewards/presenters";
import { parseProducts } from "../../utils/wall-campaigns";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return redirect("/app");

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: {
      customer: { select: { email: true } },
      campaign: { select: { id: true, title: true, moment: true, status: true, productScope: true, products: true, captureSpecs: true, productId: true, rewardCycles: true, rewardFrequency: true, discountType: true, discountValue: true, rewardType: true, discountCodeType: true, discountCodeAmount: true, storeCreditAmount: true, shopId: true } },
      reward: { select: { status: true, cycles: true } },
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
      ...(await (async () => {
        const { viewUrl, downloadUrl } = await mediaUrlsFor(submission);
        return { contentUrl: viewUrl, downloadUrl };
      })()),
      thumbnailUrl: submission.thumbnailUrl,
      durationSecs: submission.durationSecs,
      description: submission.description,
      fileBytes: submission.fileBytes,
      status: submission.status,
      createdAt: submission.createdAt,
      reviewedAt: submission.reviewedAt,
      reviewNote: submission.reviewNote,
      rejectionReason: submission.rejectionReason,
      rewardCycles: submission.campaign.rewardCycles,
      rewardFrequency: submission.campaign.rewardFrequency,
      discountType: submission.campaign.discountType,
      rewardLabel: campaignRewardLabel(submission.campaign),
      discountValue: submission.campaign.discountValue,
      rewardStatus: submission.reward?.status || null,
      rewardType: submission.campaign.rewardType,
      hasReward: submission.campaign.rewardType === "DISCOUNT_CODE" || submission.campaign.rewardType === "STORE_CREDIT",
      products: parseProducts(submission.products),
      showsName: submission.displayName,
      wall: {
        id: submission.campaign.id,
        title: submission.campaign.title,
        status: submission.campaign.status,
        ask: submission.campaign.moment,
        checklist: (() => {
          try {
            return (JSON.parse(submission.campaign.captureSpecs) as { label: string; description: string }[])
              .filter((x) => x.label === "Requirement")
              .map((x) => x.description);
          } catch {
            return [] as string[];
          }
        })(),
        scopeAll: submission.campaign.productScope === "ALL",
        products: parseProducts(submission.campaign.products),
      },
    },
    nextPendingId: nextPending?.id || null,
    approvals: await (async () => {
      const a = await checkSubmissionLimit(shop.id, (shop.planTier as PlanTierKey) || "FREE");
      return { used: a.used, limit: Number.isFinite(a.limit) ? a.limit : null, reached: !a.ok };
    })(),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: {
      id: true,
      subscriptionProvider: true,
      providerApiKey: true,
      providerConnected: true,
    },
  });
  if (!shop) return json({ error: "Shop not found" }, { status: 400 });

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: { campaign: true },
  });
  if (!submission || submission.campaign.shopId !== shop.id) {
    return json({ error: "Not found" }, { status: 404 });
  }

  if (actionType === "approve") {
    try {
      const result = await approveSubmission({ submissionId: params.id!, shop, admin });
      return json({ success: true, action: "approved", ...result });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Approval failed" }, { status: 400 });
    }
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

    // Delete the file from R2 to free storage
    const r2Key = extractKeyFromContentUrl(submission.contentUrl);
    if (r2Key) {
      try {
        await deleteObject(r2Key);
      } catch (err) {
        console.error("[UGME] R2 delete error on reject:", err);
        // Non-fatal — submission is still rejected even if R2 delete fails
      }
    }

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

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function ProductThumb({ url, size, round }: { url: string | null; size: number; round?: boolean }) {
  return (
    <div style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: round ? 999 : 8, overflow: "hidden", background: "var(--p-color-bg-surface-secondary)", border: "1px solid var(--p-color-border-secondary)" }}>
      {url && <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
    </div>
  );
}

export default function SubmissionDetail() {
  const { submission, nextPendingId, approvals } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { success?: boolean; action?: string; error?: string; rewardStatus?: string; rewardError?: string }
    | undefined;
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
  const rewardText = submission.rewardLabel;

  return (
    <Page
      backAction={{ content: "Submissions", url: "/app/library" }}
      title={`Submission from ${submission.displayName}`}
      titleMetadata={
        <Badge tone={isPending ? "attention" : submission.status === "APPROVED" ? "success" : "critical"}>
          {isPending ? "DECIDE" : submission.status}
        </Badge>
      }
      secondaryActions={nextPendingId ? [{ content: "Next in queue ›", url: `/app/library/${nextPendingId}` }] : []}
    >
      {actionData?.error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" action={/approvals included/.test(actionData.error) ? { content: "Upgrade plan", url: "/app/settings/billing" } : undefined}>
            {actionData.error}
          </Banner>
        </Box>
      )}
      {actionData?.success && (
        <Box paddingBlockEnd="400">
          <Banner tone={actionData.action === "approved" && actionData.rewardStatus === "FAILED" ? "warning" : "success"}>
            {actionData.action === "approved"
              ? submission.hasReward
                ? actionData.rewardStatus === "FAILED"
                  ? actionData.rewardError || `Approved and added to your wall, but the reward couldn't be sent yet — it will be retried.`
                  : `Approved and added to your wall. ${rewardText} sent to the customer.`
                : "Approved and added to your wall."
              : "Submission denied."}
          </Banner>
        </Box>
      )}

      <Layout>
        {/* ── Row 1: the content + the decision ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <div style={{ borderRadius: 12, overflow: "hidden", background: "#111", height: 520, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {submission.contentType === "VIDEO" && submission.contentUrl.startsWith("http") ? (
                  <video
                    src={submission.contentUrl}
                    poster={submission.thumbnailUrl?.startsWith("http") ? submission.thumbnailUrl : undefined}
                    controls
                    playsInline
                    // Not approved yet → review only: no download/cast/picture-in-picture
                    {...(submission.downloadUrl ? {} : { controlsList: "nodownload noremoteplayback", disablePictureInPicture: true, onContextMenu: (e: React.MouseEvent) => e.preventDefault() })}
                    style={{ width: "100%", height: "100%", objectFit: "contain", background: "#111" }}
                  />
                ) : (
                  <img
                    src={submission.thumbnailUrl || submission.contentUrl}
                    alt=""
                    draggable={false}
                    onContextMenu={submission.downloadUrl ? undefined : (e) => e.preventDefault()}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                )}
              </div>
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  {submission.contentType === "VIDEO" ? "Video" : "Photo"} · {(submission.fileBytes / (1024 * 1024)).toFixed(1)} MB
                  {submission.durationSecs ? ` · ${formatDuration(submission.durationSecs)}` : ""} · Submitted {timeAgo(submission.createdAt)}
                </Text>
                {submission.downloadUrl ? (
                  <Button url={submission.downloadUrl} size="slim">Download</Button>
                ) : (
                  <Text as="span" variant="bodySm" tone="subdued">Download available after approval</Text>
                )}
              </InlineStack>
              {submission.description && (
                <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 10, padding: "10px 12px" }}>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">Message from the customer</Text>
                    <Text as="p" variant="bodyMd">{submission.description}</Text>
                  </BlockStack>
                </div>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {isPending ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Make a decision</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {submission.hasReward
                      ? `Approving adds this to your wall and sends ${submission.displayName} ${rewardText}.`
                      : "Approving adds this to your wall."}
                  </Text>
                  {approvals.reached && (
                    <Banner tone="warning" action={{ content: "Upgrade plan", url: "/app/settings/billing" }}>
                      You've approved {approvals.used} of {approvals.limit} submissions this month. Upgrade to approve this one now, or approve it next month.
                    </Banner>
                  )}
                  {!showDenyPanel ? (
                    <BlockStack gap="200">
                      <Button variant="primary" tone="success" onClick={handleApprove} loading={isActing} disabled={approvals.reached} fullWidth>
                        {submission.hasReward ? `Approve + send ${rewardText}` : "Approve"}
                      </Button>
                      <Button tone="critical" onClick={() => setShowDenyPanel(true)} disabled={isActing} fullWidth>
                        Deny
                      </Button>
                    </BlockStack>
                  ) : (
                    <BlockStack gap="300">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">Why isn't this a match?</Text>
                      <InlineStack gap="200" wrap>
                        {DENY_REASONS.map((reason) => (
                          <Button key={reason} pressed={selectedReason === reason} onClick={() => setSelectedReason(reason)} size="slim">
                            {reason}
                          </Button>
                        ))}
                      </InlineStack>
                      <TextField
                        label="Note for the customer"
                        labelHidden
                        placeholder="Optional note for the customer…"
                        value={denyNote}
                        onChange={setDenyNote}
                        multiline={2}
                        autoComplete="off"
                      />
                      <InlineStack gap="200">
                        <Button tone="critical" variant="primary" onClick={handleDeny} disabled={!selectedReason} loading={isActing}>
                          Confirm deny
                        </Button>
                        <Button onClick={() => { setShowDenyPanel(false); setSelectedReason(null); }}>Cancel</Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">Decisions can't be undone.</Text>
                </BlockStack>
              </Card>
            ) : (
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Decision</Text>
                    <Badge tone={submission.status === "APPROVED" ? "success" : "critical"}>
                      {submission.status === "APPROVED" ? "Approved" : "Denied"}
                    </Badge>
                  </InlineStack>
                  {submission.reviewedAt && <Text as="p" variant="bodySm" tone="subdued">Reviewed {timeAgo(submission.reviewedAt)}</Text>}
                  {submission.status === "APPROVED" && submission.hasReward && (
                    <Text as="p" variant="bodyMd">Reward: <b>{rewardText}</b></Text>
                  )}
                  {submission.rejectionReason && <Text as="p" variant="bodyMd">Reason: {submission.rejectionReason}</Text>}
                  {submission.reviewNote && <Text as="p" variant="bodySm" tone="subdued">“{submission.reviewNote}”</Text>}
                </BlockStack>
              </Card>
            )}

            {/* Who shared it */}
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <div style={{ width: 40, height: 40, flex: "0 0 40px", borderRadius: 999, background: "var(--p-color-bg-fill-secondary)", display: "grid", placeItems: "center", fontWeight: 650, fontSize: 14, color: "var(--p-color-text-secondary)" }}>
                    {initials(submission.displayName)}
                  </div>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>{submission.displayName}</Text>
                    <Text as="p" variant="bodySm" tone="subdued" truncate>{submission.email}</Text>
                  </BlockStack>
                </InlineStack>

                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">Bought</Text>
                    <Badge tone="success">Verified purchase</Badge>
                  </InlineStack>
                  {submission.products.length ? (
                    submission.products.map((p) => (
                      <InlineStack key={p.id} gap="300" blockAlign="center" wrap={false}>
                        <ProductThumb url={p.imageUrl} size={36} />
                        <Text as="span" variant="bodyMd" truncate>{p.title}</Text>
                      </InlineStack>
                    ))
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">No products linked.</Text>
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">Shown as product cards next to this post on the wall.</Text>
                </BlockStack>

                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">On the wall as</Text>
                  <Text as="p" variant="bodySm">{submission.showsName || "“Verified buyer” (name hidden)"}</Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* ── Row 2: what it was submitted to ── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">{submission.wall.title}</Text>
                  <Badge tone={submission.wall.status === "ACTIVE" ? "success" : "attention"}>
                    {submission.wall.status === "ACTIVE" ? "Active" : submission.wall.status === "PAUSED" ? "Paused" : "Draft"}
                  </Badge>
                  <Badge tone={submission.hasReward ? "success" : "info"}>
                    {submission.hasReward ? `Reward: ${rewardText}` : "Featured, no reward"}
                  </Badge>
                </InlineStack>
                <Button variant="plain" url={`/app/walls/${submission.wall.id}`}>View wall campaign</Button>
              </InlineStack>

              <InlineGrid columns={{ xs: 1, md: submission.wall.checklist.length ? 2 : 1 }} gap="400">
                <div style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 12, padding: 16, height: "100%" }}>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">You asked for</Text>
                    <Text as="p" variant="bodyLg">{submission.wall.ask}</Text>
                  </BlockStack>
                </div>
                {submission.wall.checklist.length > 0 && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">Checklist</Text>
                    {submission.wall.checklist.map((c) => (
                      <div key={c} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid var(--p-color-border-secondary)", borderRadius: 10 }}>
                        <span style={{ width: 18, height: 18, flex: "0 0 18px", borderRadius: 999, background: "var(--p-color-bg-fill-success-secondary)", color: "var(--p-color-text-success)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>✓</span>
                        <Text as="span" variant="bodyMd">{c}</Text>
                      </div>
                    ))}
                  </BlockStack>
                )}
              </InlineGrid>

              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">Who can share</Text>
                {submission.wall.scopeAll ? (
                  <Text as="p" variant="bodyMd">Anyone who has ordered from your store</Text>
                ) : (
                  <InlineStack gap="200" wrap>
                    {submission.wall.products.map((p) => (
                      <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 12px 4px 4px", border: "1px solid var(--p-color-border-secondary)", borderRadius: 999 }}>
                        <ProductThumb url={p.imageUrl} size={24} round />
                        <Text as="span" variant="bodySm">{p.title}</Text>
                      </span>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
