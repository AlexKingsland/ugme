/** Data for the Overview page: plan summary + real setup progress. */
import prisma from "../db.server";
import { getPlan, type PlanTierKey } from "./plans.server";
import { addToThemeUrl, getWallUsage } from "./wall-theme.server";

type Graphql = Parameters<typeof getWallUsage>[0];

export async function overviewData(graphql: Graphql, shop: { id: string; shopDomain: string; planTier: string | null }) {
  const plan = getPlan((shop.planTier as PlanTierKey) || "FREE");
  const walls = await prisma.campaign.findMany({
    where: { shopId: shop.id, rewardType: { not: "SUBSCRIPTION_DISCOUNT" }, status: { not: "CLOSED" } },
    select: { id: true },
  });
  const [usage, approved] = await Promise.all([
    walls.length ? getWallUsage(graphql, walls.map((w) => w.id)) : Promise.resolve(null),
    prisma.submission.count({ where: { campaign: { shopId: shop.id }, status: "APPROVED" } }),
  ]);
  return {
    themeUrl: addToThemeUrl(shop.shopDomain, process.env.SHOPIFY_API_KEY || ""),
    planName: plan.name,
    planLine: `Includes ${
      plan.submissionsPerMonth === Infinity
        ? "unlimited approved posts"
        : plan.approvalPeriod === "total"
          ? `${plan.submissionsPerMonth} approved posts`
          : `${plan.submissionsPerMonth} approved posts a month`
    } and ${plan.storageLabel} of storage. Every feature is included on every plan.`,
    steps: {
      wall: walls.length > 0,
      theme: !!usage && usage.status === "ok" && Object.values(usage.byCampaign).some((used) => used.length > 0),
      posts: approved > 0,
    },
    firstWallId: walls[0]?.id ?? null,
  };
}

export type OverviewData = Awaited<ReturnType<typeof overviewData>>;
