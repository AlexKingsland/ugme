import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, Link } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  Box,
  Select,
  InlineGrid,
  ProgressBar,
  Divider,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

const TIER_LIMITS: Record<string, { bytes: number; label: string }> = {
  TIER_10GB:  { bytes: 10 * 1024 * 1024 * 1024,   label: "10 GB" },
  TIER_100GB: { bytes: 100 * 1024 * 1024 * 1024,  label: "100 GB" },
  TIER_1TB:   { bytes: 1024 * 1024 * 1024 * 1024,  label: "1 TB" },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function timeAgo(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function formatDuration(secs: number | null): string {
  if (!secs) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function formatReward(discountType: string, discountValue: number, months: number): string {
  if (discountType === "FREE") return `${months} mo free`;
  if (discountType === "FIXED_AMOUNT") return `$${discountValue}/mo × ${months} mo`;
  if (discountType === "PERCENTAGE") return `${discountValue}% off × ${months} mo`;
  return `${months} mo`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") || "pending";
  const campaignFilter = url.searchParams.get("campaign") || "all";
  const mediaFilter = url.searchParams.get("media") || "all";
  const sort = url.searchParams.get("sort") || "oldest";

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) {
    return json({
      items: [], campaigns: [], counts: { pending: 0, approved: 0 },
      storage: { usedBytes: 0, tier: "TIER_10GB" },
      tab, campaignFilter, mediaFilter, sort,
    });
  }

  // Campaigns for filter dropdown
  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    select: { id: true, title: true },
    orderBy: { createdAt: "desc" },
  });

  // Build where clause — never show rejected
  const where: any = {
    campaign: { shopId: shop.id },
    status: tab === "approved" ? "APPROVED" : "PENDING",
  };
  if (campaignFilter !== "all") {
    where.campaignId = campaignFilter;
  }
  if (mediaFilter !== "all") {
    where.contentType = mediaFilter;
  }

  const items = await prisma.submission.findMany({
    where,
    include: {
      customer: { select: { email: true } },
      campaign: { select: { title: true, rewardMonths: true, discountType: true, discountValue: true } },
    },
    orderBy: { createdAt: tab === "pending" ? (sort === "oldest" ? "asc" : "desc") : "desc" },
  });

  // Counts (excluding rejected)
  const allSubs = await prisma.submission.findMany({
    where: { campaign: { shopId: shop.id }, status: { in: ["PENDING", "APPROVED"] } },
    select: { status: true },
  });
  const counts = {
    pending: allSubs.filter((s) => s.status === "PENDING").length,
    approved: allSubs.filter((s) => s.status === "APPROVED").length,
  };

  // Storage
  const storageAgg = await prisma.submission.aggregate({
    where: { campaign: { shopId: shop.id } },
    _sum: { fileBytes: true },
  });

  return json({
    items: items.map((s) => ({
      id: s.id,
      email: s.customer.email,
      displayName: s.customer.email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
      campaignTitle: s.campaign.title,
      description: s.description || "",
      contentType: s.contentType,
      contentUrl: s.contentUrl,
      thumbnailUrl: s.thumbnailUrl,
      durationSecs: s.durationSecs,
      fileBytes: s.fileBytes,
      status: s.status,
      createdAt: s.createdAt,
      rewardMonths: s.campaign.rewardMonths,
      discountType: s.campaign.discountType,
      discountValue: s.campaign.discountValue,
      usageTags: JSON.parse(s.usageTags || "[]"),
      rightsAccepted: s.rightsAccepted,
      markedUsed: s.markedUsed,
    })),
    campaigns: campaigns.map((c) => ({ id: c.id, title: c.title })),
    counts,
    storage: {
      usedBytes: storageAgg._sum.fileBytes || 0,
      tier: shop.storageTier,
    },
    tab,
    campaignFilter,
    mediaFilter,
    sort,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return json({ error: "Shop not found" }, { status: 400 });

  if (actionType === "approve") {
    const submissionId = formData.get("submissionId") as string;
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { campaign: true },
    });
    if (!submission || submission.campaign.shopId !== shop.id) {
      return json({ error: "Not found" }, { status: 404 });
    }
    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        rightsAccepted: true,
        usageTags: JSON.stringify(["Social + Product Pages"]),
      },
    });
    await prisma.reward.upsert({
      where: { submissionId },
      update: { status: "APPLIED", appliedAt: new Date() },
      create: {
        submissionId,
        customerId: submission.customerId,
        months: submission.campaign.rewardMonths,
        discountProvider: "SHOPIFY_NATIVE",
        status: "APPLIED",
        appliedAt: new Date(),
      },
    });
    return json({ success: true });
  }

  if (actionType === "deny") {
    const submissionId = formData.get("submissionId") as string;
    const reason = formData.get("reason") as string;
    // Rejected = permanently discarded, won't show anywhere
    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        rejectionReason: reason || "Does not meet campaign requirements",
        reviewNote: reason || "Does not meet campaign requirements",
      },
    });
    return json({ success: true });
  }

  if (actionType === "markUsed") {
    const id = formData.get("submissionId") as string;
    await prisma.submission.update({ where: { id }, data: { markedUsed: true } });
    return json({ success: true });
  }

  if (actionType === "unmarkUsed") {
    const id = formData.get("submissionId") as string;
    await prisma.submission.update({ where: { id }, data: { markedUsed: false } });
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function Library() {
  const { items, campaigns, counts, storage, tab, campaignFilter, mediaFilter, sort } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isActing = navigation.state === "submitting";

  const [currentTab, setCurrentTab] = useState(tab);
  const [currentCampaign, setCurrentCampaign] = useState(campaignFilter);
  const [currentMedia, setCurrentMedia] = useState(mediaFilter);
  const [currentSort, setCurrentSort] = useState(sort);
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());

  const tierInfo = TIER_LIMITS[storage.tier] || TIER_LIMITS.TIER_10GB;
  const storagePct = Math.min((storage.usedBytes / tierInfo.bytes) * 100, 100);

  const navigate = useCallback((overrides: Record<string, string>) => {
    const params = new URLSearchParams();
    params.set("tab", overrides.tab ?? currentTab);
    params.set("campaign", overrides.campaign ?? currentCampaign);
    params.set("media", overrides.media ?? currentMedia);
    params.set("sort", overrides.sort ?? currentSort);
    submit(params, { method: "get" });
  }, [currentTab, currentCampaign, currentMedia, currentSort, submit]);

  const handleTabChange = useCallback((t: string) => {
    setCurrentTab(t);
    setSelectedAssets(new Set());
    navigate({ tab: t });
  }, [navigate]);

  const handleApprove = useCallback((submissionId: string) => {
    const formData = new FormData();
    formData.set("submissionId", submissionId);
    formData.set("_action", "approve");
    submit(formData, { method: "post" });
  }, [submit]);

  const handleDeny = useCallback((submissionId: string) => {
    const formData = new FormData();
    formData.set("submissionId", submissionId);
    formData.set("_action", "deny");
    formData.set("reason", "Does not meet campaign requirements");
    submit(formData, { method: "post" });
  }, [submit]);

  const handleMarkUsed = useCallback((id: string, used: boolean) => {
    const formData = new FormData();
    formData.set("_action", used ? "markUsed" : "unmarkUsed");
    formData.set("submissionId", id);
    submit(formData, { method: "post" });
  }, [submit]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isPending = currentTab === "pending";

  return (
    <Page
      backAction={{ content: "Dashboard", url: "/app" }}
      title="Library"
      secondaryActions={
        !isPending && selectedAssets.size > 0
          ? [{ content: `Export selected (${selectedAssets.size})` }]
          : []
      }
      primaryAction={
        !isPending && items.length > 0
          ? { content: "Download all" }
          : undefined
      }
    >
      <BlockStack gap="400">
        {/* Tab bar + storage */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200">
                <Button
                  pressed={isPending}
                  onClick={() => handleTabChange("pending")}
                  size="slim"
                >
                  Pending ({counts.pending})
                </Button>
                <Button
                  pressed={!isPending}
                  onClick={() => handleTabChange("approved")}
                  size="slim"
                >
                  Approved ({counts.approved})
                </Button>
              </InlineStack>
              <InlineStack gap="300" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  {formatBytes(storage.usedBytes)} / {tierInfo.label}
                </Text>
                <Box width="120px">
                  <ProgressBar
                    progress={storagePct}
                    tone={storagePct >= 90 ? "critical" : storagePct >= 70 ? "highlight" : "primary"}
                    size="small"
                  />
                </Box>
              </InlineStack>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Filters */}
        <Card>
          <InlineStack gap="300" blockAlign="end">
            <Box width="240px">
              <Select
                label="Campaign"
                options={[
                  { label: "All campaigns", value: "all" },
                  ...campaigns.map((c: any) => ({ label: c.title, value: c.id })),
                ]}
                value={currentCampaign}
                onChange={(v) => {
                  setCurrentCampaign(v);
                  navigate({ campaign: v });
                }}
              />
            </Box>
            <Box width="160px">
              <Select
                label="Media"
                options={[
                  { label: "Any type", value: "all" },
                  { label: "Video", value: "VIDEO" },
                  { label: "Photo", value: "PHOTO" },
                ]}
                value={currentMedia}
                onChange={(v) => {
                  setCurrentMedia(v);
                  navigate({ media: v });
                }}
              />
            </Box>
            {isPending && (
              <Box width="160px">
                <Select
                  label="Sort"
                  options={[
                    { label: "Oldest first", value: "oldest" },
                    { label: "Newest first", value: "newest" },
                  ]}
                  value={currentSort}
                  onChange={(v) => {
                    setCurrentSort(v);
                    navigate({ sort: v });
                  }}
                />
              </Box>
            )}
            <Box>
              <Text as="span" variant="bodySm" tone="subdued">
                {items.length} {isPending ? "submission" : "asset"}{items.length !== 1 ? "s" : ""}
              </Text>
            </Box>
          </InlineStack>
        </Card>

        {/* Helpful context for pending */}
        {isPending && counts.pending > 0 && (
          <Text as="p" variant="bodySm" tone="subdued">
            {counts.pending} waiting for review · oldest first so customers aren't left hanging.
          </Text>
        )}

        {/* Empty state */}
        {items.length === 0 ? (
          <Card>
            <Box padding="800">
              <BlockStack gap="200" inlineAlign="center">
                <Text as="p" variant="headingMd" alignment="center">
                  {isPending ? "You're all caught up" : "No approved content yet"}
                </Text>
                <Text as="p" tone="subdued" alignment="center">
                  {isPending
                    ? "No submissions waiting for review."
                    : "Approved submissions will appear here as downloadable assets."}
                </Text>
              </BlockStack>
            </Box>
          </Card>
        ) : isPending ? (
          /* ───── PENDING: Review list ───── */
          <BlockStack gap="200">
            {items.map((sub: any) => (
              <Card key={sub.id}>
                <InlineStack gap="400" blockAlign="center" wrap={false}>
                  {/* Thumbnail */}
                  <Link to={`/app/library/${sub.id}`} style={{ textDecoration: "none" }}>
                    <div style={{ position: "relative", width: 64, height: 64, borderRadius: 8, overflow: "hidden", background: "#f3f3f3", flexShrink: 0 }}>
                      <img
                        src={sub.thumbnailUrl || "https://placehold.co/64x64/e5e7eb/9ca3af?text=?"}
                        alt=""
                        style={{ width: 64, height: 64, objectFit: "cover", display: "block" }}
                      />
                      {sub.contentType === "VIDEO" && sub.durationSecs && (
                        <div style={{
                          position: "absolute", bottom: 2, right: 4,
                          background: "rgba(0,0,0,0.7)", color: "#fff",
                          fontSize: 10, fontWeight: 600, padding: "1px 4px", borderRadius: 3,
                        }}>
                          {formatDuration(sub.durationSecs)}
                        </div>
                      )}
                    </div>
                  </Link>

                  {/* Info */}
                  <Box width="100%">
                    <Link to={`/app/library/${sub.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">{sub.displayName}</Text>
                          <Text as="span" tone="subdued">·</Text>
                          <Text as="span" tone="subdued">{sub.campaignTitle}</Text>
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {sub.contentType === "VIDEO" ? "Video" : "Photo"}{sub.description ? `: ${sub.description}` : ""}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          Waiting {timeAgo(sub.createdAt)} · {formatReward(sub.discountType, sub.discountValue, sub.rewardMonths)} reward
                        </Text>
                      </BlockStack>
                    </Link>
                  </Box>

                  {/* Quick actions */}
                  <InlineStack gap="200">
                    <Button
                      tone="success"
                      variant="primary"
                      onClick={() => handleApprove(sub.id)}
                      loading={isActing}
                      size="slim"
                    >
                      Approve
                    </Button>
                    <Button
                      tone="critical"
                      onClick={() => handleDeny(sub.id)}
                      loading={isActing}
                      size="slim"
                    >
                      Deny
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Card>
            ))}
            <Text as="p" variant="bodySm" tone="subdued">
              Approving issues the reward immediately. Denied submissions are permanently discarded.
            </Text>
          </BlockStack>
        ) : (
          /* ───── APPROVED: Asset grid ───── */
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
            {items.map((asset: any) => (
              <Card key={asset.id}>
                <BlockStack gap="300">
                  {/* Thumbnail */}
                  <div
                    style={{
                      position: "relative",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "#f3f3f3",
                      aspectRatio: "4/3",
                      cursor: "pointer",
                    }}
                    onClick={() => toggleSelect(asset.id)}
                  >
                    <img
                      src={asset.thumbnailUrl || "https://placehold.co/400x300/e5e7eb/9ca3af?text=?"}
                      alt={asset.description}
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                    {asset.contentType === "VIDEO" && asset.durationSecs && (
                      <div style={{
                        position: "absolute", top: 8, right: 8,
                        background: "rgba(0,0,0,0.7)", color: "#fff",
                        fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                        display: "flex", alignItems: "center", gap: 4,
                      }}>
                        ▶ {formatDuration(asset.durationSecs)}
                      </div>
                    )}
                    {selectedAssets.has(asset.id) && (
                      <div style={{
                        position: "absolute", top: 8, left: 8,
                        width: 24, height: 24, borderRadius: 6,
                        background: "#1a1a1a", color: "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, fontWeight: 700,
                      }}>
                        ✓
                      </div>
                    )}
                    {asset.markedUsed && (
                      <div style={{
                        position: "absolute", bottom: 8, left: 8,
                        background: "rgba(0,0,0,0.6)", color: "#fff",
                        fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                      }}>
                        Used
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{asset.displayName}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        · {(asset.fileBytes / (1024 * 1024)).toFixed(0)} MB
                      </Text>
                    </InlineStack>
                    {asset.description && (
                      <Text as="p" variant="bodySm" tone="subdued">{asset.description}</Text>
                    )}
                  </BlockStack>

                  {/* Tags */}
                  <InlineStack gap="200" wrap>
                    {asset.usageTags.map((tag: string, i: number) => (
                      <Badge key={i} tone="success">{tag}</Badge>
                    ))}
                    {asset.rightsAccepted && (
                      <Badge tone="info">Rights</Badge>
                    )}
                  </InlineStack>

                  {/* Actions */}
                  <InlineStack gap="200">
                    <Button size="slim" url={`/app/library/${asset.id}`}>View</Button>
                    <Button size="slim">Download</Button>
                    <Button
                      size="slim"
                      onClick={() => handleMarkUsed(asset.id, !asset.markedUsed)}
                    >
                      {asset.markedUsed ? "Unmark" : "Mark used"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        )}
      </BlockStack>
    </Page>
  );
}
