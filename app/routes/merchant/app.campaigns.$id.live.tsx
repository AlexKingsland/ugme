import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Button,
  Banner,
  TextField,
  Divider,
  Badge,
  Icon,
} from "@shopify/polaris";
import {
  ClipboardIcon,
  EmailIcon,
  CodeIcon,
  ShareIcon,
  CheckCircleIcon,
} from "@shopify/polaris-icons";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      shop: { select: { shopDomain: true } },
    },
  });

  if (!campaign) {
    throw new Response("Campaign not found", { status: 404 });
  }

  // Build the customer-facing submission URL
  const submitUrl = `https://${campaign.shop.shopDomain}/apps/ugme/campaign/${campaign.id}`;

  return json({ campaign, submitUrl });
};

export default function CampaignLive() {
  const { campaign, submitUrl } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [linkCopied, setLinkCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(submitUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [submitUrl]);

  const embedCode = `<a href="${submitUrl}" target="_blank" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:8px;text-decoration:none;font-family:system-ui;font-weight:600;">Share your experience →</a>`;

  const handleCopyEmbed = useCallback(() => {
    navigator.clipboard.writeText(embedCode);
    setEmbedCopied(true);
    setTimeout(() => setEmbedCopied(false), 2000);
  }, [embedCode]);

  return (
    <Page
      title="Your campaign is live!"
      subtitle="Now get it in front of the customers who can make it happen"
      primaryAction={{
        content: "View campaign dashboard",
        onAction: () => navigate(`/app/campaigns/${campaign.id}`),
      }}
    >
      {/* Success banner */}
      <Box paddingBlockEnd="500">
        <Banner tone="success">
          <InlineStack gap="200" align="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {campaign.title}
            </Text>
            <Badge tone="success">Active</Badge>
            <Text as="span" variant="bodyMd">
              is now accepting submissions
            </Text>
          </InlineStack>
        </Banner>
      </Box>

      <Layout>
        {/* ── Main column: distribution methods ── */}
        <Layout.Section>
          <BlockStack gap="500">
            {/* Shareable link */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={ShareIcon} tone="base" />
                    <Text as="h2" variant="headingMd">
                      Shareable link
                    </Text>
                  </InlineStack>
                  <Badge>Easiest</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Share this link with customers via email, social media, or
                  anywhere else. Anyone with a valid subscription can submit.
                </Text>
                <InlineStack gap="300" blockAlign="end">
                  <Box minWidth="0" width="100%">
                    <TextField
                      label=""
                      labelHidden
                      value={submitUrl}
                      readOnly
                      autoComplete="off"
                      selectTextOnFocus
                    />
                  </Box>
                  <Button
                    icon={linkCopied ? CheckCircleIcon : ClipboardIcon}
                    onClick={handleCopyLink}
                    variant={linkCopied ? "primary" : undefined}
                  >
                    {linkCopied ? "Copied!" : "Copy"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Email invite */}
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={EmailIcon} tone="base" />
                  <Text as="h2" variant="headingMd">
                    Email your subscribers
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Send a personalized email to your subscribers inviting them to
                  participate. Works great with Klaviyo, Mailchimp, or your
                  existing email tool.
                </Text>
                <BlockStack gap="300">
                  <Card>
                    <Box
                      padding="400"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          Suggested email copy:
                        </Text>
                        <Text as="p" variant="bodyMd">
                          Hey [First Name],
                        </Text>
                        <Text as="p" variant="bodyMd">
                          Love our products? We'd love to see how you use them!
                          Share a quick video or photo and earn{" "}
                          <Text as="span" fontWeight="semibold">
                            {campaign.rewardMonths} free month
                            {campaign.rewardMonths > 1 ? "s" : ""}
                          </Text>{" "}
                          on your subscription.
                        </Text>
                        <Text as="p" variant="bodyMd">
                          👉 Submit here: {submitUrl}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Card>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Embed code */}
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={CodeIcon} tone="base" />
                  <Text as="h2" variant="headingMd">
                    Embed on your site
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Add a call-to-action button to your store, post-purchase page,
                  or customer portal. Paste this snippet into any page.
                </Text>
                <Box
                  padding="400"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <Text as="p" variant="bodyMd">
                    <code
                      style={{
                        fontSize: "12px",
                        wordBreak: "break-all",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {embedCode}
                    </code>
                  </Text>
                </Box>
                <InlineStack align="end">
                  <Button
                    icon={embedCopied ? CheckCircleIcon : ClipboardIcon}
                    onClick={handleCopyEmbed}
                    variant={embedCopied ? "primary" : undefined}
                  >
                    {embedCopied ? "Copied!" : "Copy embed code"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* ── Sidebar: campaign summary ── */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Campaign summary
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      Title
                    </Text>
                    <Text as="span" fontWeight="semibold">
                      {campaign.title}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      Content type
                    </Text>
                    <Badge>{campaign.contentType || "VIDEO"}</Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      Reward
                    </Text>
                    <Text as="span" fontWeight="semibold">
                      {campaign.rewardMonths} free month
                      {campaign.rewardMonths > 1 ? "s" : ""}
                    </Text>
                  </InlineStack>
                  {campaign.maxSubmissions && (
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Submission cap
                      </Text>
                      <Text as="span" fontWeight="semibold">
                        {campaign.maxSubmissions}
                      </Text>
                    </InlineStack>
                  )}
                  {campaign.endDate && (
                    <InlineStack align="space-between">
                      <Text as="span" tone="subdued">
                        Ends
                      </Text>
                      <Text as="span" fontWeight="semibold">
                        {new Date(campaign.endDate).toLocaleDateString()}
                      </Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  What's next?
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="start" wrap={false}>
                    <div
                      style={{
                        width: "28px",
                        height: "28px",
                        minWidth: "28px",
                        borderRadius: "50%",
                        background: "#e3e3e3",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: "600",
                      }}
                    >
                        1
                    </div>
                    <BlockStack gap="100">
                      <Text as="span" fontWeight="semibold">
                        Share the link
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Send the submission link to your subscribers
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start" wrap={false}>
                    <div
                      style={{
                        width: "28px",
                        height: "28px",
                        minWidth: "28px",
                        borderRadius: "50%",
                        background: "#e3e3e3",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: "600",
                      }}
                    >
                        2
                    </div>
                    <BlockStack gap="100">
                      <Text as="span" fontWeight="semibold">
                        Review submissions
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Approve or deny content as it comes in
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="start" wrap={false}>
                    <div
                      style={{
                        width: "28px",
                        height: "28px",
                        minWidth: "28px",
                        borderRadius: "50%",
                        background: "#e3e3e3",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        fontWeight: "600",
                      }}
                    >
                        3
                    </div>
                    <BlockStack gap="100">
                      <Text as="span" fontWeight="semibold">
                        Download & use
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Use approved content in ads and socials
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
