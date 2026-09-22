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
  Popover,
  ActionList,
  Icon,
} from "@shopify/polaris";
import {
  MenuHorizontalIcon,
  ImportIcon,
  CheckIcon,
  XIcon,
} from "@shopify/polaris-icons";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { extractKeyFromContentUrl, getPresignedDownloadUrl, deleteObject } from "../../utils/r2.server";

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
  const productFilter = url.searchParams.get("product") || "all";
  const usedFilter = url.searchParams.get("used") || "all";

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) {
    return json({
      items: [], campaigns: [], products: [], counts: { pending: 0, approved: 0 },
      storage: { usedBytes: 0, tier: "TIER_10GB" },
      tab, campaignFilter, mediaFilter, sort, productFilter, usedFilter,
    });
  }

  // Campaigns for filter dropdown
  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    select: { id: true, title: true, productTitle: true, productId: true },
    orderBy: { createdAt: "desc" },
  });

  // Build unique product list from campaigns
  const productMap = new Map<string, string>();
  campaigns.forEach((c) => {
    if (c.productId && c.productTitle) {
      productMap.set(c.productId, c.productTitle);
    }
  });
  const products = Array.from(productMap.entries()).map(([id, title]) => ({ id, title }));

  // Build where clause — never show rejected
  const where: any = {
    campaign: { shopId: shop.id },
    status: tab === "approved" ? "APPROVED" : "PENDING",
  };
  if (campaignFilter !== "all") {
    where.campaignId = campaignFilter;
  }
  if (productFilter !== "all") {
    // Find all campaign IDs for this product
    const productCampaignIds = campaigns
      .filter((c) => c.productId === productFilter)
      .map((c) => c.id);
    if (productCampaignIds.length > 0) {
      where.campaignId = where.campaignId
        ? where.campaignId
        : { in: productCampaignIds };
    } else {
      where.campaignId = "nonexistent"; // no results
    }
  }
  if (mediaFilter !== "all") {
    where.contentType = mediaFilter;
  }
  if (tab === "approved" && usedFilter !== "all") {
    where.markedUsed = usedFilter === "used";
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

  // Resolve R2 URLs to presigned download URLs
  const resolvedItems = await Promise.all(
    items.map(async (s) => {
      let resolvedUrl = s.contentUrl;
      const r2Key = extractKeyFromContentUrl(s.contentUrl);
      if (r2Key && r2Key !== "pending") {
        try {
          resolvedUrl = await getPresignedDownloadUrl(r2Key);
        } catch {
          resolvedUrl = s.contentUrl;
        }
      }
      return {
        id: s.id,
        email: s.customer.email,
        displayName: s.customer.email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        campaignTitle: s.campaign.title,
        description: s.description || "",
        contentType: s.contentType,
        contentUrl: resolvedUrl,
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
      };
    })
  );

  return json({
    items: resolvedItems,
    campaigns: campaigns.map((c) => ({ id: c.id, title: c.title })),
    counts,
    products,
    storage: {
      usedBytes: storageAgg._sum.fileBytes || 0,
      tier: shop.storageTier,
    },
    tab,
    campaignFilter,
    mediaFilter,
    sort,
    productFilter,
    usedFilter,
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

  if (actionType === "delete") {
    const submissionId = formData.get("submissionId") as string;
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, contentUrl: true, campaign: { select: { shopId: true } } },
    });
    if (!submission || submission.campaign.shopId !== shop.id) {
      return json({ error: "Not found" }, { status: 404 });
    }
    // Delete from R2
    const r2Key = extractKeyFromContentUrl(submission.contentUrl);
    if (r2Key && r2Key !== "pending") {
      try { await deleteObject(r2Key); } catch (e) { console.error("[UGME] R2 delete failed:", e); }
    }
    // Delete associated rewards, then the submission
    await prisma.reward.deleteMany({ where: { submissionId } });
    await prisma.submission.delete({ where: { id: submissionId } });
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function Library() {
  const { items, campaigns, counts, storage, tab, campaignFilter, mediaFilter, sort, products, productFilter, usedFilter } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isActing = navigation.state === "submitting";

  const [currentTab, setCurrentTab] = useState(tab);
  const [currentCampaign, setCurrentCampaign] = useState(campaignFilter);
  const [currentMedia, setCurrentMedia] = useState(mediaFilter);
  const [currentProduct, setCurrentProduct] = useState(productFilter);
  const [currentSort, setCurrentSort] = useState(sort);
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
  const [currentUsed, setCurrentUsed] = useState(usedFilter);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const tierInfo = TIER_LIMITS[storage.tier] || TIER_LIMITS.TIER_10GB;
  const storagePct = Math.min((storage.usedBytes / tierInfo.bytes) * 100, 100);

  const navigate = useCallback((overrides: Record<string, string>) => {
    const params = new URLSearchParams();
    params.set("tab", overrides.tab ?? currentTab);
    params.set("campaign", overrides.campaign ?? currentCampaign);
    params.set("media", overrides.media ?? currentMedia);
    params.set("sort", overrides.sort ?? currentSort);
    params.set("product", overrides.product ?? currentProduct);
    params.set("used", overrides.used ?? currentUsed);
    submit(params, { method: "get" });
  }, [currentTab, currentCampaign, currentMedia, currentSort, currentProduct, currentUsed, submit]);

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

  const handleDelete = useCallback((id: string) => {
    if (!confirm("Delete this submission? This will permanently remove the file and cannot be undone.")) return;
    const formData = new FormData();
    formData.set("_action", "delete");
    formData.set("submissionId", id);
    submit(formData, { method: "post" });
  }, [submit]);

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
                  {`Pending (${counts.pending})`}
                </Button>
                <Button
                  pressed={!isPending}
                  onClick={() => handleTabChange("approved")}
                  size="slim"
                >
                  {`Approved (${counts.approved})`}
                </Button>
              </InlineStack>
              <InlineStack gap="300" blockAlign="center">
                <Badge tone={storagePct >= 90 ? "critical" : storagePct >= 70 ? "attention" : "info"}>
                  {`${tierInfo.label} plan`}
                </Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  {formatBytes(storage.usedBytes)} used
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
            {products.length > 0 && (
              <Box width="200px">
                <Select
                  label="Product"
                  options={[
                    { label: "All products", value: "all" },
                    ...products.map((p: any) => ({ label: p.title, value: p.id })),
                  ]}
                  value={currentProduct}
                  onChange={(v) => {
                    setCurrentProduct(v);
                    navigate({ product: v });
                  }}
                />
              </Box>
            )}
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
            {!isPending && (
              <Box width="160px">
                <Select
                  label="Status"
                  options={[
                    { label: "All", value: "all" },
                    { label: "Used", value: "used" },
                    { label: "Unused", value: "unused" },
                  ]}
                  value={currentUsed}
                  onChange={(v) => {
                    setCurrentUsed(v);
                    navigate({ used: v });
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
            {items.map((sub: any) => {
              const hasUrl = sub.contentUrl.startsWith("http");
              return (
              <Card key={sub.id}>
                <InlineStack gap="400" blockAlign="center" wrap={false}>
                  {/* Thumbnail */}
                  <Link to={`/app/library/${sub.id}`} style={{ textDecoration: "none" }}>
                    <div style={{ position: "relative", width: 64, height: 64, borderRadius: 8, overflow: "hidden", background: "#1a1a1a", flexShrink: 0 }}>
                      {sub.contentType === "VIDEO" && hasUrl ? (
                        <video
                          src={sub.contentUrl}
                          preload="metadata"
                          muted
                          style={{ width: 64, height: 64, objectFit: "cover", display: "block" }}
                        />
                      ) : sub.contentType === "PHOTO" && hasUrl ? (
                        <img
                          src={sub.contentUrl}
                          alt=""
                          style={{ width: 64, height: 64, objectFit: "cover", display: "block" }}
                        />
                      ) : (
                        <div style={{ width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontSize: 10 }}>
                          {sub.contentType === "VIDEO" ? "VID" : "IMG"}
                        </div>
                      )}
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
              );
            })}
            <Text as="p" variant="bodySm" tone="subdued">
              Approving issues the reward immediately. Denied submissions are permanently discarded.
            </Text>
          </BlockStack>
        ) : (
          /* ───── APPROVED: Asset grid ───── */
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
            {items.map((asset: any) => {
              const hasResolvedUrl = asset.contentUrl.startsWith("http");
              return (
                <Card key={asset.id}>
                  <BlockStack gap="300">
                    {/* Clickable thumbnail */}
                    <Link to={`/app/library/${asset.id}`} style={{ textDecoration: "none" }}>
                      <div style={{
                        position: "relative", borderRadius: 8, overflow: "hidden",
                        background: "#1a1a1a", aspectRatio: "4/3", cursor: "pointer",
                      }}>
                        {asset.contentType === "VIDEO" && hasResolvedUrl ? (
                          <video
                            src={asset.contentUrl}
                            preload="metadata"
                            muted
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          />
                        ) : asset.contentType === "PHOTO" && hasResolvedUrl ? (
                          <img
                            src={asset.contentUrl}
                            alt={asset.description || "Photo submission"}
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          />
                        ) : (
                          <div style={{
                            width: "100%", height: "100%",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            color: "#666", fontSize: 14,
                          }}>
                            {asset.contentType === "VIDEO" ? "Video" : "Photo"}
                          </div>
                        )}

                        {/* Video duration badge */}
                        {asset.contentType === "VIDEO" && (
                          <div style={{
                            position: "absolute", bottom: 8, right: 8,
                            background: "rgba(0,0,0,0.75)", color: "#fff",
                            fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 4,
                            pointerEvents: "none",
                          }}>
                            {asset.durationSecs ? formatDuration(asset.durationSecs) : "Video"}
                          </div>
                        )}

                        {/* Used badge */}
                        {asset.markedUsed && (
                          <div style={{
                            position: "absolute", top: 8, left: 8,
                            background: "#fff", color: "#1a1a1a",
                            fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                            textTransform: "uppercase", letterSpacing: "0.5px",
                            pointerEvents: "none",
                          }}>
                            Used
                          </div>
                        )}

                        {/* Selection checkmark */}
                        {selectedAssets.has(asset.id) && (
                          <div style={{
                            position: "absolute", top: 8, right: 8,
                            width: 24, height: 24, borderRadius: "50%",
                            background: "#2c6ecb", display: "flex",
                            alignItems: "center", justifyContent: "center",
                            pointerEvents: "none",
                          }}>
                            <Icon source={CheckIcon}  />
                          </div>
                        )}
                      </div>
                    </Link>

                    {/* Info row with ⋯ menu */}
                    <InlineStack align="space-between" blockAlign="center" wrap={false}>
                      <Link to={`/app/library/${asset.id}`} style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0, overflow: "hidden" }}>
                        <BlockStack gap="050">
                          <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>{asset.displayName}</Text>
                          <Text as="span" variant="bodySm" tone="subdued" truncate>
                            {asset.campaignTitle} · {formatBytes(asset.fileBytes)}
                          </Text>
                        </BlockStack>
                      </Link>
                      <div style={{ flexShrink: 0 }}>
                        <Popover
                          active={openMenuId === asset.id}
                          activator={
                            <Button
                              icon={MenuHorizontalIcon}
                              variant="tertiary"
                              size="slim"
                              onClick={() => setOpenMenuId(openMenuId === asset.id ? null : asset.id)}
                              accessibilityLabel="Actions"
                            />
                          }
                          onClose={() => setOpenMenuId(null)}
                          preferredAlignment="right"
                        >
                          <ActionList
                            items={[
                              ...(hasResolvedUrl
                                ? [{
                                    content: "Download",
                                    icon: ImportIcon,
                                    onAction: () => {
                                      setOpenMenuId(null);
                                      const a = document.createElement("a");
                                      a.href = asset.contentUrl;
                                      a.download = "";
                                      a.target = "_blank";
                                      a.click();
                                    },
                                  }]
                                : []),
                              {
                                content: asset.markedUsed ? "Unmark used" : "Mark used",
                                icon: asset.markedUsed ? XIcon : CheckIcon,
                                onAction: () => {
                                  setOpenMenuId(null);
                                  handleMarkUsed(asset.id, !asset.markedUsed);
                                },
                              },
                              {
                                content: "Delete",
                                icon: XIcon,
                                destructive: true,
                                onAction: () => {
                                  setOpenMenuId(null);
                                  handleDelete(asset.id);
                                },
                              },
                            ]}
                          />
                        </Popover>
                      </div>
                    </InlineStack>
                  </BlockStack>
                </Card>
              );
            })}
          </InlineGrid>
        )}
      </BlockStack>
    </Page>
  );
}
