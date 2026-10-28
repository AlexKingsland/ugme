import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import * as React from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Select,
  Banner,
  Box,
  Button,
  DataTable,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { getSalesSummary, shopTimeZone } from "../../utils/attribution.server";
import { extractKeyFromContentUrl, getPresignedDownloadUrl } from "../../utils/r2.server";
import { activatePixel, pixelStatus } from "../../utils/web-pixel.server";
import { RevenueChart, ShareChart, DIRECT_COLOR, INFLUENCED_COLOR } from "../../components/SalesCharts";

const RANGES = [7, 30, 90] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  if (!shop) return redirect("/app");

  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = (RANGES as readonly number[]).includes(requested) ? requested : 30;

  const [timeZone, pixel] = await Promise.all([shopTimeZone(admin.graphql, session.shop), pixelStatus(admin.graphql)]);
  const summary = await getSalesSummary(shop.id, days, timeZone);
  const topPosts = await Promise.all(
    summary.topPosts.map(async (p) => {
      let thumb: string | null = null;
      const key = p.thumbnailUrl ? extractKeyFromContentUrl(p.thumbnailUrl) : null;
      if (key && key !== "pending") thumb = await getPresignedDownloadUrl(key).catch(() => null);
      return { ...p, thumbnailUrl: thumb };
    }),
  );

  return json({ summary: { ...summary, topPosts }, pixel });
};

/** "Turn on sales tracking" — only ever runs because the merchant pressed the button. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "enable-pixel") return json({ ok: false }, { status: 400 });
  const ok = await activatePixel(admin.graphql, session.shop);
  return json({ ok });
};

function useMoney(currency: string) {
  return React.useMemo(() => {
    const whole = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 });
    const exact = new Intl.NumberFormat(undefined, { style: "currency", currency });
    return {
      axis: (cents: number) => whole.format(cents / 100),
      exact: (cents: number) => exact.format(cents / 100),
    };
  }, [currency]);
}

function pctText(part: number, whole: number) {
  if (!whole) return "—";
  const v = (part / whole) * 100;
  return `${v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

function Stat({ label, value, help, swatch }: { label: string; value: string; help?: string; swatch?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <InlineStack gap="150" blockAlign="center">
          {swatch && <span style={{ width: 10, height: 10, borderRadius: 3, background: swatch }} />}
          <Text as="p" variant="bodyMd" tone="subdued">{label}</Text>
        </InlineStack>
        <Text as="p" variant="headingXl">{value}</Text>
        {help && <Text as="p" variant="bodySm" tone="subdued">{help}</Text>}
      </BlockStack>
    </Card>
  );
}

export default function Analytics() {
  const { summary, pixel } = useLoaderData<typeof loader>();
  const pixelFetcher = useFetcher<{ ok: boolean }>();
  const enabling = pixelFetcher.state !== "idle";
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const money = useMoney(summary.currency);
  const [showTable, setShowTable] = React.useState(false);
  const wallCents = summary.directCents + summary.influencedCents;
  const hasOrders = summary.trackingSince !== null;

  return (
    <Page title="Analytics" subtitle="Sales your Social Walls drove" backAction={{ url: "/app" }}>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">
            {hasOrders
              ? `Tracking since ${new Date(summary.trackingSince!).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}. Revenue is after discounts and refunds, before shipping and tax.`
              : "Tracking starts with your next order."}
          </Text>
          <div style={{ minWidth: 160 }}>
            <Select
              label="Date range"
              labelInline
              options={[
                { label: "Last 7 days", value: "7" },
                { label: "Last 30 days", value: "30" },
                { label: "Last 90 days", value: "90" },
              ]}
              value={String(summary.days)}
              onChange={(v) => {
                const next = new URLSearchParams(params);
                next.set("days", v);
                navigate(`?${next.toString()}`, { replace: true });
              }}
            />
          </div>
        </InlineStack>

        {pixel === "off" && (
          <Banner
            tone="warning"
            title="“Buy it now” sales aren't being counted"
            action={{
              content: "Turn on sales tracking",
              loading: enabling,
              onAction: () => pixelFetcher.submit({ intent: "enable-pixel" }, { method: "post" }),
            }}
          >
            Social Wall's sales tracking is disconnected under Settings → Customer events. Purchases made with “Buy it
            now” skip the cart, so without it they can't be credited to the posts shoppers watched. Sales through the
            cart are still counted.
          </Banner>
        )}
        {pixelFetcher.data && !pixelFetcher.data.ok && (
          <Banner tone="critical" title="Couldn't turn on sales tracking">Please try again in a moment.</Banner>
        )}

        {!hasOrders && (
          <Banner tone="info" title="No orders yet">
            Once shoppers buy, you'll see revenue from products added to cart from your walls (direct) and products they
            bought within 7 days of watching a post about them (influenced).
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <Stat label="Wall revenue" value={money.exact(wallCents)} help="Direct + influenced" />
          <Stat label="Direct" value={money.exact(summary.directCents)} swatch={DIRECT_COLOR} help={`${summary.directOrders} order${summary.directOrders === 1 ? "" : "s"} · added from the wall`} />
          <Stat label="Influenced" value={money.exact(summary.influencedCents)} swatch={INFLUENCED_COLOR} help={`${summary.influencedOrders} order${summary.influencedOrders === 1 ? "" : "s"} · watched, then bought`} />
          <Stat label="Share of store revenue" value={pctText(wallCents, summary.totalCents)} help={`of ${money.exact(summary.totalCents)} total`} />
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Revenue from your walls</Text>
            <RevenueChart data={summary.series} money={money.axis} />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Share of store revenue</Text>
              <Text as="p" variant="bodySm" tone="subdued">Wall revenue (direct + influenced) as a percent of each day's store revenue.</Text>
            </BlockStack>
            <ShareChart data={summary.series} money={money.exact} />
            <Divider />
            <InlineStack>
              <Button variant="plain" onClick={() => setShowTable((s) => !s)}>{showTable ? "Hide data table" : "Show data table"}</Button>
            </InlineStack>
            {showTable && (
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                headings={["Date", "Direct", "Influenced", "Store revenue", "Share"]}
                rows={[...summary.series].reverse().map((d) => [
                  d.date,
                  money.exact(d.direct),
                  money.exact(d.influenced),
                  money.exact(d.total),
                  pctText(d.direct + d.influenced, d.total),
                ])}
              />
            )}
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Top posts</Text>
              {summary.topPosts.length === 0 ? (
                <Text as="p" tone="subdued">Posts that drive sales will show up here.</Text>
              ) : (
                <BlockStack gap="200">
                  {summary.topPosts.map((p) => (
                    <a key={p.submissionId} href={`/app/library/${p.submissionId}`} style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "inherit", padding: "4px 0" }}>
                      <div style={{ width: 44, height: 44, flex: "0 0 44px", borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-surface-secondary)", border: "1px solid var(--p-color-border-secondary)" }}>
                        {p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>{p.displayName ? `${p.displayName}'s post` : "Post"}{p.campaignTitle ? ` · ${p.campaignTitle}` : ""}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{money.exact(p.directCents)} direct · {money.exact(p.influencedCents)} influenced</Text>
                      </div>
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{money.exact(p.directCents + p.influencedCents)}</Text>
                    </a>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Top wall campaigns</Text>
              {summary.topWalls.length === 0 ? (
                <Text as="p" tone="subdued">Wall campaigns that drive sales will show up here.</Text>
              ) : (
                <BlockStack gap="200">
                  {summary.topWalls.map((w) => (
                    <InlineStack key={w.campaignId} align="space-between" blockAlign="center" wrap={false} gap="300">
                      <div style={{ minWidth: 0 }}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>{w.title}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{money.exact(w.directCents)} direct · {money.exact(w.influencedCents)} influenced</Text>
                      </div>
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{money.exact(w.directCents + w.influencedCents)}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">How sales are counted</Text>
            <Text as="p" tone="subdued">
              <strong>Direct:</strong> the shopper pressed Add to cart on a wall post's product card.{" "}
              <strong>Influenced:</strong> the shopper watched a post for a few seconds, then bought a product linked to that
              post within 7 days. Only those products get credit — never the rest of the cart. Views are tracked in the
              shopper's browser, so purchases on another device aren't counted.
            </Text>
          </BlockStack>
        </Card>
        <Box paddingBlockEnd="400" />
      </BlockStack>
    </Page>
  );
}
