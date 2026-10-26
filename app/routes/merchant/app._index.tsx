import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  ResourceList,
  ResourceItem,
  Box,
  InlineGrid,
  Banner,
  ProgressBar,
  Thumbnail,
} from "@shopify/polaris";
import { SubmissionThumbnail } from "../../components/SubmissionThumbnail";
import { extractKeyFromContentUrl, getPresignedDownloadUrl } from "../../utils/r2.server";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { getPlan, type PlanTierKey } from "../../utils/plans.server";
import { formatBytes } from "../../utils/format";
import { parseProducts } from "../../utils/wall-campaigns";
import { campaignRewardLabel } from "../../utils/rewards/presenters";

const ROW_H = 72;
const ROW_GAP = 4;
const PLACEHOLDER_IMG = "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_small.png";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return redirect("/app/walls");

  const walls = await prisma.campaign.findMany({
    where: { shopId: shop.id, rewardType: { not: "SUBSCRIPTION_DISCOUNT" }, status: { not: "CLOSED" } },
    select: {
      id: true,
      title: true,
      status: true,
      productScope: true,
      products: true,
      rewardType: true,
      discountType: true,
      discountValue: true,
      rewardCycles: true,
      rewardFrequency: true,
      discountCodeType: true,
      discountCodeAmount: true,
      storeCreditAmount: true,
      _count: { select: { submissions: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  // New merchants land on the "create your first wall" screen
  if (!walls.length) return redirect("/app/walls");

  const inShop = { campaign: { shopId: shop.id } };
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [onWall, pendingCount, rewardsSent, storageAgg, monthlySubmissions, pendingRaw] = await Promise.all([
    prisma.submission.count({ where: { ...inShop, status: "APPROVED" } }),
    prisma.submission.count({ where: { ...inShop, status: "PENDING" } }),
    prisma.reward.count({ where: { customer: { shopId: shop.id }, status: "APPLIED", rewardType: { in: ["DISCOUNT_CODE", "STORE_CREDIT"] } } }),
    prisma.submission.aggregate({ where: inShop, _sum: { fileBytes: true } }),
    prisma.submission.count({ where: { ...inShop, createdAt: { gte: monthStart } } }),
    prisma.submission.findMany({
      where: { ...inShop, status: "PENDING" },
      include: { customer: { select: { email: true } }, campaign: { select: { title: true } } },
      orderBy: { createdAt: "asc" }, // oldest first — that's the review queue order
      take: 6,
    }),
  ]);

  const pending = await Promise.all(
    pendingRaw.map(async (s) => {
      let url = s.thumbnailUrl || s.contentUrl;
      const key = extractKeyFromContentUrl(url);
      if (key && key !== "pending") url = await getPresignedDownloadUrl(key).catch(() => url);
      return {
        id: s.id,
        email: s.customer.email,
        wall: s.campaign.title,
        products: parseProducts(s.products).map((p) => p.title).join(", "),
        contentType: s.thumbnailUrl ? "PHOTO" : s.contentType,
        contentUrl: url,
        durationSecs: s.durationSecs,
        createdAt: s.createdAt,
      };
    }),
  );

  const plan = getPlan((shop.planTier as PlanTierKey) || "FREE");
  return json({
    stats: { liveWalls: walls.filter((w) => w.status === "ACTIVE").length, onWall, pendingCount, rewardsSent },
    storage: { usedBytes: storageAgg._sum.fileBytes || 0, plan },
    submissions: { monthlyCount: monthlySubmissions, plan },
    pending,
    walls: walls.map((w) => {
      const products = parseProducts(w.products);
      return {
        id: w.id,
        title: w.title,
        status: w.status,
        image: products[0]?.imageUrl ?? null,
        detail: `${w.productScope === "ALL" ? "All products" : products.length === 1 ? products[0].title : `${products.length} products`} · ${campaignRewardLabel(w)}`,
        submissions: w._count.submissions,
      };
    }),
  });
};

function timeAgo(d: string) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function StatCard({ title, value, helpText, url }: { title: string; value: number; helpText?: string; url?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" tone="subdued">{title}</Text>
        <Text as="p" variant="headingXl">{value}</Text>
        {helpText && (url ? <Button variant="plain" url={url}>{helpText}</Button> : <Text as="p" variant="bodySm" tone="subdued">{helpText}</Text>)}
      </BlockStack>
    </Card>
  );
}

function UsageCard({ title, used, limit, usedLabel, limitLabel, planName, nearFull, full }: {
  title: string; used: number; limit: number; usedLabel: string; limitLabel: string; planName: string; nearFull: string; full: string;
}) {
  const pct = limit === Infinity || !limit ? 0 : Math.min((used / limit) * 100, 100);
  const isHigh = pct >= 80;
  const isCritical = pct >= 95;
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">{title}</Text>
          <Badge tone={isCritical ? "critical" : isHigh ? "attention" : "info"}>{`${planName} plan`}</Badge>
        </InlineStack>
        <ProgressBar progress={pct} tone={isCritical ? "critical" : isHigh ? "highlight" : "primary"} size="small" />
        <InlineStack align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">{usedLabel}</Text>
          <Text as="p" variant="bodySm" tone="subdued">{limitLabel}</Text>
        </InlineStack>
        {isHigh && (
          <Banner tone={isCritical ? "critical" : "warning"} action={{ content: "Upgrade plan", url: "/app/settings/billing" }}>
            {isCritical ? full : nearFull}
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}

const STATUS: Record<string, { tone?: "success" | "attention" | "info"; label: string }> = {
  ACTIVE: { tone: "success", label: "Active" },
  PAUSED: { tone: "attention", label: "Paused" },
  DRAFT: { tone: "info", label: "Draft" },
};

export default function Dashboard() {
  const { stats, storage, submissions, pending, walls } = useLoaderData<typeof loader>();

  return (
    <Page title="Dashboard" primaryAction={{ content: "Create wall campaign", url: "/app/walls/new" }}>
      <BlockStack gap="500">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard title="Live walls" value={stats.liveWalls} />
          <StatCard title="Waiting for review" value={stats.pendingCount} helpText={stats.pendingCount ? "Review now" : "All caught up"} url={stats.pendingCount ? "/app/library" : undefined} />
          <StatCard title="On your walls" value={stats.onWall} helpText="Approved submissions" />
          <StatCard title="Rewards sent" value={stats.rewardsSent} helpText="Discount codes + store credit" />
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <UsageCard
            title="Storage"
            used={storage.usedBytes}
            limit={storage.plan.storageBytes}
            usedLabel={`${formatBytes(storage.usedBytes)} used`}
            limitLabel={`${storage.plan.storageLabel} limit`}
            planName={storage.plan.name}
            nearFull="Storage is getting full. Upgrade to keep accepting submissions."
            full="You're almost out of storage. Upgrade your plan to keep accepting submissions."
          />
          <UsageCard
            title="Submissions this month"
            used={submissions.monthlyCount}
            limit={submissions.plan.submissionsPerMonth}
            usedLabel={`${submissions.monthlyCount} this month`}
            limitLabel={`${submissions.plan.submissionLabel} limit`}
            planName={submissions.plan.name}
            nearFull="You're getting close to this month's submission limit."
            full="You're almost at this month's submission limit. Upgrade to keep accepting submissions."
          />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">Waiting for review</Text>
                    {stats.pendingCount > 0 && <Badge tone="attention">{String(stats.pendingCount)}</Badge>}
                  </InlineStack>
                  <Button size="slim" url="/app/library">Open submissions</Button>
                </InlineStack>
                {pending.length === 0 ? (
                  <Text as="p" tone="subdued">Nothing to review. New submissions from verified buyers will show up here.</Text>
                ) : (
                  <ResourceList
                    items={pending}
                    renderItem={(s) => (
                      <ResourceItem
                        id={s.id}
                        url={`/app/library/${s.id}`}
                        media={<SubmissionThumbnail contentType={s.contentType} contentUrl={s.contentUrl} durationSecs={s.durationSecs} size={40} />}
                        accessibilityLabel={`Review submission from ${s.email}`}
                      >
                        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">{s.email}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {s.products ? `Bought ${s.products} · ` : ""}{s.wall}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="300" blockAlign="center" wrap={false}>
                            <Text as="span" variant="bodySm" tone="subdued">{timeAgo(s.createdAt)}</Text>
                            <Button size="slim" url={`/app/library/${s.id}`}>Review</Button>
                          </InlineStack>
                        </InlineStack>
                      </ResourceItem>
                    )}
                  />
                )}
                {stats.pendingCount > pending.length && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    + {stats.pendingCount - pending.length} more in Submissions
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Wall campaigns</Text>
                  <Button size="slim" variant="plain" url="/app/walls">View all</Button>
                </InlineStack>
                {/* ~3 rows visible; the rest scroll inside the card */}
                <div style={{ maxHeight: 3 * ROW_H + 2 * ROW_GAP, overflowY: "auto", margin: "0 -4px", padding: "0 4px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
                    {walls.map((w) => {
                      const st = STATUS[w.status] ?? { label: w.status };
                      return (
                        <a
                          key={w.id}
                          href={`/app/walls/${w.id}`}
                          style={{ display: "flex", alignItems: "center", gap: 12, height: ROW_H, padding: "0 8px", borderRadius: 10, textDecoration: "none", color: "inherit" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--p-color-bg-surface-hover)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ width: 48, height: 48, flex: "0 0 48px", borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-surface-secondary)", border: "1px solid var(--p-color-border-secondary)" }}>
                            <img src={w.image || PLACEHOLDER_IMG} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                              <div style={{ minWidth: 0, flex: "0 1 auto" }}>
                                <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>{w.title}</Text>
                              </div>
                              <div style={{ flex: "0 0 auto" }}>
                                <Badge tone={st.tone}>{st.label}</Badge>
                              </div>
                            </div>
                            <Text as="p" variant="bodySm" tone="subdued" truncate>{w.detail}</Text>
                            <Text as="p" variant="bodySm" tone="subdued" truncate>{w.submissions} submission{w.submissions === 1 ? "" : "s"}</Text>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                </div>
                <Box paddingBlockStart="100">
                  <Button variant="primary" url="/app/walls/new">Create wall campaign</Button>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
