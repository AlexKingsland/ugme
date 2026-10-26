import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useSubmit, useNavigation, useFetcher, useActionData } from "@remix-run/react";
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
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

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
        defaultRewardCycles: 1,
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
      defaultRewardCycles: shop.defaultRewardCycles,
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
    const defaultRewardCycles = parseInt(
      formData.get("defaultRewardCycles") as string,
      10,
    );

    await prisma.shop.upsert({
      where: { shopDomain: session.shop },
      update: {
        defaultRewardCycles: isNaN(defaultRewardCycles) ? 1 : defaultRewardCycles,
      },
      create: {
        shopDomain: session.shop,
        accessToken: session.accessToken || "",
        defaultRewardCycles: isNaN(defaultRewardCycles) ? 1 : defaultRewardCycles,
      },
    });

    return json({ success: true, intent: "save-rewards" });
  }

  if (intent === "connect-provider") {
    const subscriptionProvider = formData.get("subscriptionProvider") as string;
    const providerApiKey = formData.get("providerApiKey") as string;

    // Validate the API key before saving
    if (subscriptionProvider === "RECHARGE") {
      if (!providerApiKey || providerApiKey.trim() === "") {
        return json({ success: false, intent: "connect-provider", error: "Please enter your ReCharge API token." });
      }

      // Validate the token can authenticate and create discounts (write access)
      const token = providerApiKey.trim();
      const rechargeHeaders = {
        "X-Recharge-Access-Token": token,
        "X-Recharge-Version": "2021-11",
        "Content-Type": "application/json",
      };

      try {
        // 1. Check auth + read access
        const readRes = await fetch("https://api.rechargeapps.com/discounts?limit=1", {
          headers: rechargeHeaders,
        });

        if (readRes.status === 401 || readRes.status === 403) {
          return json({ success: false, intent: "connect-provider", error: "Invalid ReCharge API token. Please check your token and try again." });
        }

        if (!readRes.ok) {
          return json({ success: false, intent: "connect-provider", error: `ReCharge API returned status ${readRes.status}. Please try again.` });
        }

        // 2. Check write access — create a disabled test discount then delete it
        const testCode = `UGME_ACTIVATION_TEST_${Date.now()}`;
        const createRes = await fetch("https://api.rechargeapps.com/discounts", {
          method: "POST",
          headers: rechargeHeaders,
          body: JSON.stringify({
            channel: "checkout_page",
            code: testCode,
            discount_type: "percentage",
            value_type: "percentage",
            value: "0.01",
            status: "disabled",
          }),
        });

        if (!createRes.ok) {
          return json({ success: false, intent: "connect-provider", error: "Your token can read discounts but cannot create them. Make sure it has read & write access to Discounts." });
        }

        // Clean up immediately
        const createData: any = await createRes.json();
        const testDiscountId = createData.discount?.id;
        if (testDiscountId) {
          await fetch(`https://api.rechargeapps.com/discounts/${testDiscountId}`, {
            method: "DELETE",
            headers: rechargeHeaders,
          });
        }
      } catch (err) {
        return json({ success: false, intent: "connect-provider", error: `Could not reach ReCharge API: ${err instanceof Error ? err.message : "Unknown error"}` });
      }
    }

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
  const actionData = useActionData<{ success: boolean; intent?: string; error?: string }>();
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
  const [defaultRewardCycles, setDefaultRewardMonths] = useState(
    String(shop.defaultRewardCycles),
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
    formData.set("defaultRewardCycles", defaultRewardCycles);
    submit(formData, { method: "post" });
  }, [defaultRewardCycles, submit]);

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
        {/* Plan & billing */}
        <Layout.AnnotatedSection
          id="billing"
          title="Plan & billing"
          description="Manage your Social Wall plan and view current usage."
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Current plan</Text>
                <Badge>Free</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Upgrade your plan to unlock more storage and monthly submissions.
              </Text>
              <InlineStack align="end">
                <Link to="/app/settings/billing">
                  <Button>Manage plan</Button>
                </Link>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* Brand settings */}
        <Layout.AnnotatedSection
          id="brand"
          title="Brand"
          description="How your brand appears to customers on share pages and in emails."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Brand name"
                value={brandName}
                onChange={setBrandName}
                placeholder="My Awesome Brand"
                helpText="Shown to customers on the share page and in emails"
                autoComplete="off"
              />
              <TextField
                label="Logo URL"
                value={logoUrl}
                onChange={setLogoUrl}
                placeholder="https://example.com/logo.png"
                helpText="Your logo for the share page and emails"
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

      </Layout>

    </Page>
  );
}
