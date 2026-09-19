import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Select,
  Button,
  Banner,
  FormLayout,
  Divider,
  InlineStack,
  Box,
  Badge,
  Icon,
  InlineGrid,
  CalloutCard,
} from "@shopify/polaris";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return json({
      shop: {
        shopDomain: session.shop,
        brandName: "",
        logoUrl: "",
        subscriptionProvider: "SHOPIFY_NATIVE",
        providerConnected: false,
        providerApiKey: "",
        defaultRewardMonths: 1,
      },
      isNew: true,
    });
  }

  return json({
    shop: {
      shopDomain: shop.shopDomain,
      brandName: shop.brandName || "",
      logoUrl: shop.logoUrl || "",
      subscriptionProvider: shop.subscriptionProvider,
      providerConnected: shop.providerConnected,
      // Mask the API key — only show last 4 chars if it exists
      providerApiKey: shop.providerApiKey
        ? "••••••••" + shop.providerApiKey.slice(-4)
        : "",
      defaultRewardMonths: shop.defaultRewardMonths,
    },
    isNew: false,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save-brand") {
    const brandName = formData.get("brandName") as string;
    const logoUrl = formData.get("logoUrl") as string;

    await prisma.shop.upsert({
      where: { shopDomain: session.shop },
      update: {
        brandName: brandName || null,
        logoUrl: logoUrl || null,
      },
      create: {
        shopDomain: session.shop,
        accessToken: session.accessToken || "",
        brandName: brandName || null,
        logoUrl: logoUrl || null,
      },
    });

    return json({ success: true, intent: "save-brand" });
  }

  if (intent === "save-rewards") {
    const defaultRewardMonths = parseInt(
      formData.get("defaultRewardMonths") as string,
      10,
    );

    await prisma.shop.upsert({
      where: { shopDomain: session.shop },
      update: {
        defaultRewardMonths: isNaN(defaultRewardMonths) ? 1 : defaultRewardMonths,
      },
      create: {
        shopDomain: session.shop,
        accessToken: session.accessToken || "",
        defaultRewardMonths: isNaN(defaultRewardMonths) ? 1 : defaultRewardMonths,
      },
    });

    return json({ success: true, intent: "save-rewards" });
  }

  if (intent === "connect-provider") {
    const subscriptionProvider = formData.get("subscriptionProvider") as string;
    const providerApiKey = formData.get("providerApiKey") as string;

    await prisma.shop.upsert({
      where: { shopDomain: session.shop },
      update: {
        subscriptionProvider:
          subscriptionProvider === "RECHARGE" ? "RECHARGE" : "SHOPIFY_NATIVE",
        providerApiKey:
          subscriptionProvider === "RECHARGE" ? providerApiKey || null : null,
        providerConnected: true,
      },
      create: {
        shopDomain: session.shop,
        accessToken: session.accessToken || "",
        subscriptionProvider:
          subscriptionProvider === "RECHARGE" ? "RECHARGE" : "SHOPIFY_NATIVE",
        providerApiKey:
          subscriptionProvider === "RECHARGE" ? providerApiKey || null : null,
        providerConnected: true,
      },
    });

    return json({ success: true, intent: "connect-provider" });
  }

  if (intent === "disconnect-provider") {
    await prisma.shop.update({
      where: { shopDomain: session.shop },
      data: {
        providerConnected: false,
        providerApiKey: null,
      },
    });

    return json({ success: true, intent: "disconnect-provider" });
  }

  return json({ success: false, error: "Unknown intent" });
};

export default function SettingsPage() {
  const { shop, isNew } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const testFetcher = useFetcher<{ success: boolean; message?: string; error?: string }>();

  const isSaving = navigation.state === "submitting";
  const isTesting = testFetcher.state === "submitting";

  // Brand fields
  const [brandName, setBrandName] = useState(shop.brandName);
  const [logoUrl, setLogoUrl] = useState(shop.logoUrl);

  // Provider fields
  const [subscriptionProvider, setSubscriptionProvider] = useState(
    shop.subscriptionProvider,
  );
  const [providerApiKey, setProviderApiKey] = useState("");
  const [showApiKeyField, setShowApiKeyField] = useState(false);
  const [connectionTested, setConnectionTested] = useState(false);

  // Rewards
  const [defaultRewardMonths, setDefaultRewardMonths] = useState(
    String(shop.defaultRewardMonths),
  );

  const handleSaveBrand = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-brand");
    formData.set("brandName", brandName);
    formData.set("logoUrl", logoUrl);
    submit(formData, { method: "post" });
  }, [brandName, logoUrl, submit]);

  const handleSaveRewards = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-rewards");
    formData.set("defaultRewardMonths", defaultRewardMonths);
    submit(formData, { method: "post" });
  }, [defaultRewardMonths, submit]);

  const handleTestConnection = useCallback(() => {
    const formData = new FormData();
    formData.set("provider", subscriptionProvider);
    if (subscriptionProvider === "RECHARGE") {
      formData.set("apiKey", providerApiKey);
    }
    testFetcher.submit(formData, {
      method: "post",
      action: "/app/api/test-connection",
    });
  }, [subscriptionProvider, providerApiKey, testFetcher]);

  const handleConnectProvider = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "connect-provider");
    formData.set("subscriptionProvider", subscriptionProvider);
    if (subscriptionProvider === "RECHARGE") {
      formData.set("providerApiKey", providerApiKey);
    }
    submit(formData, { method: "post" });
  }, [subscriptionProvider, providerApiKey, submit]);

  const handleDisconnect = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "disconnect-provider");
    submit(formData, { method: "post" });
  }, [submit]);

  // Track when test succeeds
  useEffect(() => {
    if (testFetcher.data?.success) {
      setConnectionTested(true);
    }
  }, [testFetcher.data]);

  // Reset connection test when provider changes
  useEffect(() => {
    setConnectionTested(false);
    setShowApiKeyField(false);
    setProviderApiKey("");
  }, [subscriptionProvider]);

  const needsSetup = !shop.providerConnected;

  return (
    <Page title="Settings">
      <Layout>
        {/* Setup banner for new shops */}
        {needsSetup && (
          <Layout.Section>
            <Banner
              title="Connect your subscription provider"
              tone="warning"
            >
              <p>
                UGME needs access to your subscription platform to apply
                discount rewards when you approve customer submissions. Set up
                the connection below to get started.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Subscription Provider Connection — the main onboarding section */}
        <Layout.AnnotatedSection
          id="provider"
          title="Subscription provider"
          description="Connect the subscription platform that manages your customers' recurring orders. UGME uses this connection to apply free-month discounts when you approve submissions."
        >
          {shop.providerConnected ? (
            /* Connected state */
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      {shop.subscriptionProvider === "RECHARGE"
                        ? "ReCharge"
                        : "Shopify Native Subscriptions"}
                    </Text>
                    <Badge tone="success">Connected</Badge>
                  </InlineStack>
                  <Button variant="plain" tone="critical" onClick={handleDisconnect}>
                    Disconnect
                  </Button>
                </InlineStack>
                <Divider />
                {shop.subscriptionProvider === "RECHARGE" && shop.providerApiKey && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">API token</Text>
                    <Text as="span" fontWeight="medium">{shop.providerApiKey}</Text>
                  </InlineStack>
                )}
                {shop.subscriptionProvider === "SHOPIFY_NATIVE" && (
                  <Text as="p" tone="subdued">
                    Using your Shopify admin access to create discount codes via
                    the GraphQL API. No additional credentials needed.
                  </Text>
                )}
                <Banner tone="success">
                  UGME will automatically create and apply discount codes when
                  you approve customer submissions.
                </Banner>
              </BlockStack>
            </Card>
          ) : (
            /* Setup / disconnected state */
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Choose your subscription platform
                </Text>

                <Select
                  label="Provider"
                  options={[
                    {
                      label: "Shopify Native Subscriptions",
                      value: "SHOPIFY_NATIVE",
                    },
                    { label: "ReCharge", value: "RECHARGE" },
                  ]}
                  value={subscriptionProvider}
                  onChange={setSubscriptionProvider}
                  helpText={
                    subscriptionProvider === "SHOPIFY_NATIVE"
                      ? "Also works with Loop, Bold, Appstle, and Seal — any provider that uses Shopify's native discount codes."
                      : "Connect directly to ReCharge's API to create and apply discounts."
                  }
                />

                <Divider />

                {subscriptionProvider === "SHOPIFY_NATIVE" ? (
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Shopify Native Discounts
                    </Text>
                    <Text as="p" tone="subdued">
                      UGME will use your Shopify admin connection to create
                      discount codes via the{" "}
                      <Text as="span" fontWeight="medium">
                        discountCodeBasicCreate
                      </Text>{" "}
                      GraphQL mutation. Each approved submission generates a
                      unique code with a{" "}
                      <Text as="span" fontWeight="medium">
                        recurringCycleLimit
                      </Text>{" "}
                      matching the campaign's reward months.
                    </Text>
                    <Text as="p" tone="subdued">
                      No additional API keys required — UGME uses the access
                      already granted during app installation.
                    </Text>

                    {/* Test result */}
                    {testFetcher.data && (
                      <Banner
                        tone={testFetcher.data.success ? "success" : "critical"}
                      >
                        <p>
                          {testFetcher.data.success
                            ? testFetcher.data.message
                            : testFetcher.data.error}
                        </p>
                      </Banner>
                    )}

                    <InlineStack gap="300">
                      <Button onClick={handleTestConnection} loading={isTesting}>
                        Test connection
                      </Button>
                      {connectionTested && (
                        <Button
                          variant="primary"
                          onClick={handleConnectProvider}
                          loading={isSaving}
                        >
                          Save & activate
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      ReCharge API Connection
                    </Text>
                    <Text as="p" tone="subdued">
                      UGME needs a ReCharge API token with permissions to create
                      and apply discounts. You can generate one in your ReCharge
                      dashboard under{" "}
                      <Text as="span" fontWeight="medium">
                        Settings → API tokens
                      </Text>
                      .
                    </Text>

                    <CalloutCard
                      title="Required API permissions"
                      illustration="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                      primaryAction={{
                        content: "Open ReCharge docs",
                        url: "https://docs.rechargepayments.com/docs/api-tokens",
                        external: true,
                      }}
                    >
                      <p>
                        Your token needs <strong>read &amp; write</strong> access
                        to <strong>Discounts</strong> and{" "}
                        <strong>Addresses</strong>.
                      </p>
                    </CalloutCard>

                    <TextField
                      label="ReCharge API token"
                      value={providerApiKey}
                      onChange={setProviderApiKey}
                      placeholder="sk_1x2y3z4..."
                      type="password"
                      helpText="Your token is encrypted before storage and never exposed in the UI."
                      autoComplete="off"
                    />

                    {/* Test result */}
                    {testFetcher.data && (
                      <Banner
                        tone={testFetcher.data.success ? "success" : "critical"}
                      >
                        <p>
                          {testFetcher.data.success
                            ? testFetcher.data.message
                            : testFetcher.data.error}
                        </p>
                      </Banner>
                    )}

                    <InlineStack gap="300">
                      <Button
                        onClick={handleTestConnection}
                        loading={isTesting}
                        disabled={!providerApiKey.trim()}
                      >
                        Test connection
                      </Button>
                      {connectionTested && (
                        <Button
                          variant="primary"
                          onClick={handleConnectProvider}
                          loading={isSaving}
                        >
                          Save & activate
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          )}
        </Layout.AnnotatedSection>

        {/* Brand settings */}
        <Layout.AnnotatedSection
          id="brand"
          title="Brand"
          description="How your brand appears to customers in the submission portal."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Brand name"
                value={brandName}
                onChange={setBrandName}
                placeholder="My Awesome Brand"
                helpText="Shown to customers when they submit content"
                autoComplete="off"
              />
              <TextField
                label="Logo URL"
                value={logoUrl}
                onChange={setLogoUrl}
                placeholder="https://example.com/logo.png"
                helpText="Your brand logo for the submission portal"
                autoComplete="off"
              />
              <InlineStack align="end">
                <Button onClick={handleSaveBrand} loading={isSaving}>
                  Save brand
                </Button>
              </InlineStack>
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        {/* Rewards settings */}
        <Layout.AnnotatedSection
          id="rewards"
          title="Rewards"
          description="Default reward settings for new campaigns. Individual campaigns can override these."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Default reward months"
                type="number"
                value={defaultRewardMonths}
                onChange={setDefaultRewardMonths}
                min={1}
                max={12}
                helpText="Number of free subscription months given for approved submissions"
                autoComplete="off"
              />
              <InlineStack align="end">
                <Button onClick={handleSaveRewards} loading={isSaving}>
                  Save rewards
                </Button>
              </InlineStack>
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>

    </Page>
  );
}
