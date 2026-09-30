import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Banner,
  Divider,
  Box,
  ProgressBar,
  InlineGrid,
} from "@shopify/polaris";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import {
  PLAN_DEFINITIONS,
  getPlan,
  checkStorageLimit,
  checkSubmissionLimit,
  formatBytes,
  type PlanTierKey,
} from "../../utils/plans.server";

// ── Loader ──────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  const planTier = (shop?.planTier as PlanTierKey) || "FREE";
  const plan = getPlan(planTier);

  const [storage, submissions] = await Promise.all([
    checkStorageLimit(shop?.id || "", planTier),
    checkSubmissionLimit(shop?.id || "", planTier),
  ]);

  return json({
    currentPlan: planTier,
    plan,
    storage: {
      usedBytes: storage.usedBytes,
      limitBytes: storage.limitBytes,
      pct: storage.pct,
      usedLabel: formatBytes(storage.usedBytes),
      limitLabel: plan.storageLabel,
    },
    submissions: {
      used: submissions.used,
      limit: submissions.limit,
      pct: submissions.pct,
    },
    plans: Object.values(PLAN_DEFINITIONS),
  });
};

// ── Action — handle plan changes via Shopify App Billing ────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const targetPlan = formData.get("plan") as PlanTierKey;

  if (intent === "change-plan") {
    const plan = getPlan(targetPlan);

    // Downgrading to free — cancel existing subscription
    if (targetPlan === "FREE") {
      const shop = await prisma.shop.findUnique({
        where: { shopDomain: session.shop },
      });

      if (shop?.shopifySubscriptionId) {
        // Cancel the active subscription via Shopify GraphQL
        await admin.graphql(
          `#graphql
          mutation appSubscriptionCancel($id: ID!) {
            appSubscriptionCancel(id: $id) {
              userErrors { field message }
            }
          }`,
          { variables: { id: shop.shopifySubscriptionId } },
        );
      }

      await prisma.shop.update({
        where: { shopDomain: session.shop },
        data: {
          planTier: "FREE",
          shopifySubscriptionId: null,
          planActivatedAt: new Date(),
        },
      });

      return json({ success: true, plan: "FREE" });
    }

    // Enterprise — just flag it, no automatic billing
    if (targetPlan === "ENTERPRISE") {
      return json({ success: false, enterprise: true });
    }

    // Paid plans — create Shopify app subscription
    const response = await admin.graphql(
      `#graphql
      mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
        appSubscriptionCreate(
          name: $name
          lineItems: $lineItems
          returnUrl: $returnUrl
          test: $test
        ) {
          appSubscription {
            id
          }
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          name: `UGME ${plan.name}`,
          lineItems: [
            {
              plan: {
                appRecurringPricingDetails: {
                  price: {
                    amount: plan.priceMonthly,
                    currencyCode: "USD",
                  },
                  interval: "EVERY_30_DAYS",
                },
              },
            },
          ],
          returnUrl: `https://${session.shop}/admin/apps/ugme/app/settings/billing?charge_activated=true&plan=${targetPlan}`,
          test: process.env.NODE_ENV !== "production",
        },
      },
    );

    const data = await response.json();
    const result = data.data?.appSubscriptionCreate;

    if (result?.userErrors?.length > 0) {
      return json({
        success: false,
        error: result.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    // Store the subscription ID so we can cancel later
    if (result?.appSubscription?.id) {
      await prisma.shop.update({
        where: { shopDomain: session.shop },
        data: {
          shopifySubscriptionId: result.appSubscription.id,
          planTier: targetPlan,
          planActivatedAt: new Date(),
        },
      });
    }

    // Redirect merchant to Shopify's confirmation page
    if (result?.confirmationUrl) {
      return redirect(result.confirmationUrl);
    }

    return json({ success: false, error: "Could not create subscription" });
  }

  return json({ success: false, error: "Unknown intent" });
};

// ── Component ───────────────────────────────────────────────────

export default function BillingPage() {
  const { currentPlan, plan, storage, submissions, plans } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  // Check URL for charge_activated callback
  const urlParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const chargeActivated = urlParams?.get("charge_activated") === "true";

  const handleChangePlan = (planKey: string) => {
    const formData = new FormData();
    formData.set("intent", "change-plan");
    formData.set("plan", planKey);
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="Plan & billing"
      backAction={{ content: "Settings", url: "/app/settings" }}
    >
      <Layout>
        {chargeActivated && (
          <Layout.Section>
            <Banner tone="success" title="Plan activated!">
              <p>
                Your plan has been updated successfully. Enjoy your new limits!
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Current plan summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    Current plan
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="headingMd">
                      {plan.name}
                    </Text>
                    {currentPlan === "FREE" ? (
                      <Badge>Free</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </InlineStack>
                </BlockStack>
                {currentPlan !== "FREE" && (
                  <Text as="span" variant="headingMd">
                    ${plan.priceMonthly}/mo
                  </Text>
                )}
              </InlineStack>

              <Divider />

              {/* Usage bars */}
              <InlineGrid columns={2} gap="400">
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      Storage
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {storage.usedLabel} / {storage.limitLabel}
                    </Text>
                  </InlineStack>
                  <ProgressBar
                    progress={storage.pct}
                    tone={
                      storage.pct >= 95
                        ? "critical"
                        : storage.pct >= 80
                          ? "highlight"
                          : "primary"
                    }
                    size="small"
                  />
                </BlockStack>

                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      Submissions this month
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {submissions.used} / {submissions.limit === Infinity ? "∞" : submissions.limit}
                    </Text>
                  </InlineStack>
                  <ProgressBar
                    progress={submissions.pct}
                    tone={
                      submissions.pct >= 95
                        ? "critical"
                        : submissions.pct >= 80
                          ? "highlight"
                          : "primary"
                    }
                    size="small"
                  />
                </BlockStack>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Plan cards */}
        <Layout.Section>
          <Text as="h2" variant="headingLg">
            Choose a plan
          </Text>
          <Box paddingBlockStart="400">
            <InlineGrid columns={4} gap="400">
              {plans.map((p) => (
                <PlanCard
                  key={p.key}
                  plan={p}
                  isCurrent={currentPlan === p.key}
                  onSelect={() => handleChangePlan(p.key)}
                  loading={isSaving}
                />
              ))}
            </InlineGrid>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function PlanCard({
  plan,
  isCurrent,
  onSelect,
  loading,
}: {
  plan: (typeof PLAN_DEFINITIONS)[PlanTierKey];
  isCurrent: boolean;
  onSelect: () => void;
  loading: boolean;
}) {
  const isEnterprise = plan.key === "ENTERPRISE";
  const isFree = plan.key === "FREE";

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">
              {plan.name}
            </Text>
            {isCurrent && <Badge tone="info">Current</Badge>}
          </InlineStack>
          <Text as="p" variant="headingLg">
            {isEnterprise ? "Custom" : isFree ? "Free" : `$${plan.priceMonthly}/mo`}
          </Text>
        </BlockStack>

        <Divider />

        <BlockStack gap="200">
          <InlineStack gap="200">
            <Text as="span" variant="bodySm" fontWeight="semibold">
              Storage:
            </Text>
            <Text as="span" variant="bodySm">
              {plan.storageLabel}
            </Text>
          </InlineStack>
          <InlineStack gap="200">
            <Text as="span" variant="bodySm" fontWeight="semibold">
              Submissions:
            </Text>
            <Text as="span" variant="bodySm">
              {plan.submissionLabel}
            </Text>
          </InlineStack>
        </BlockStack>

        <Divider />

        <BlockStack gap="100">
          {plan.features.map((f, i) => (
            <Text key={i} as="p" variant="bodySm" tone="subdued">
              ✓ {f}
            </Text>
          ))}
        </BlockStack>

        <Box paddingBlockStart="200">
          {isCurrent ? (
            <Button disabled fullWidth>
              Current plan
            </Button>
          ) : isEnterprise ? (
            <Button
              fullWidth
              url="mailto:hello@ugme.app?subject=Enterprise%20Plan%20Inquiry"
              external
            >
              Contact sales
            </Button>
          ) : (
            <Button
              variant="primary"
              fullWidth
              onClick={onSelect}
              loading={loading}
            >
              {isFree ? "Downgrade" : "Upgrade"}
            </Button>
          )}
        </Box>
      </BlockStack>
    </Card>
  );
}
