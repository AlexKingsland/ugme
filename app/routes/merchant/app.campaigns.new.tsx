import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useSubmit, useNavigation, useActionData, useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Select,
  Button,
  FormLayout,
  InlineStack,
  Box,
  Divider,
  Banner,
  RangeSlider,
  Badge,
  Checkbox,
  ButtonGroup,
  DropZone,
  Icon,
} from "@shopify/polaris";
import { useState, useCallback, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

// ── Step definitions ────────────────────────────────────────────
const STEPS = [
  { key: "product-reward", label: "Product & Reward" },
  { key: "campaign", label: "Campaign" },
  { key: "rights", label: "Rights" },
  { key: "review", label: "Review" },
] as const;

// ── Loader / Action ─────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { providerConnected: true },
  });
  return json({ providerConnected: shop?.providerConnected ?? false });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: "Shop not found. Complete setup first." }, { status: 400 });
  }

  const title = formData.get("title") as string;
  const moment = formData.get("moment") as string;
  const contentType = formData.get("contentType") as string;
  const rewardType = (formData.get("rewardType") as string) || "DISCOUNT_CODE";
  const maxSubmissions = formData.get("maxSubmissions")
    ? parseInt(formData.get("maxSubmissions") as string, 10)
    : null;
  const startDate = formData.get("startDate")
    ? new Date(formData.get("startDate") as string)
    : null;
  const endDate = formData.get("endDate")
    ? new Date(formData.get("endDate") as string)
    : null;
  const captureSpecsRaw = formData.get("captureSpecs") as string;
  const saveAsDraft = formData.get("saveAsDraft") === "true";

  const errors: string[] = [];
  if (!title?.trim()) errors.push("Title is required.");
  if (!moment?.trim()) errors.push("Creative moment is required.");
  if (startDate && endDate && endDate <= startDate) errors.push("End date must be after start date.");

  // Build campaign data based on reward type
  let rewardData: Record<string, any> = { rewardType };

  if (rewardType === "DISCOUNT_CODE") {
    const discountCodeAmount = parseFloat(formData.get("discountCodeAmount") as string) || 0;
    const discountCodeType = (formData.get("discountCodeType") as string) || "PERCENTAGE";
    const discountCodeExpiryDays = formData.get("discountCodeExpiryDays")
      ? parseInt(formData.get("discountCodeExpiryDays") as string, 10)
      : null;
    const discountCodeMinOrder = formData.get("discountCodeMinOrder")
      ? parseFloat(formData.get("discountCodeMinOrder") as string)
      : null;

    if (discountCodeAmount <= 0) errors.push("Discount amount must be greater than 0.");
    if (discountCodeType === "PERCENTAGE" && discountCodeAmount > 100) errors.push("Discount percentage must be between 1-100.");

    rewardData = {
      ...rewardData,
      discountCodeAmount,
      discountCodeType,
      discountCodeExpiryDays,
      discountCodeMinOrder,
      // Set subscription fields to defaults so they don't interfere
      discountType: "FREE",
      discountValue: 0,
      rewardCycles: 1,
      rewardFrequency: "MONTH",
    };
  } else {
    // SUBSCRIPTION_DISCOUNT
    const discountType = formData.get("discountType") as string;
    const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
    const rewardCycles = parseInt(formData.get("rewardCycles") as string, 10) || 1;
    const rewardFrequency = (formData.get("rewardFrequency") as string) || "MONTH";

    if (rewardCycles < 1 || rewardCycles > 12) errors.push("Reward months must be 1-12.");
    if (discountType === "FIXED_AMOUNT" && discountValue <= 0) errors.push("Discount amount must be greater than 0.");
    if (discountType === "PERCENTAGE" && (discountValue <= 0 || discountValue > 100)) errors.push("Discount percentage must be between 1-100.");

    rewardData = {
      ...rewardData,
      discountType: discountType as any,
      discountValue,
      rewardCycles,
      rewardFrequency: rewardFrequency as any,
      // Clear discount code fields
      discountCodeAmount: null,
      discountCodeType: null,
      discountCodeExpiryDays: null,
      discountCodeMinOrder: null,
    };
  }

  if (errors.length > 0) return json({ error: errors.join(" ") }, { status: 400 });

  let captureSpecs = "[]";
  try {
    if (captureSpecsRaw) captureSpecs = JSON.stringify(JSON.parse(captureSpecsRaw));
  } catch { /* keep default */ }

  const campaign = await prisma.campaign.create({
    data: {
      shopId: shop.id,
      title: title.trim(),
      productId: (formData.get("productId") as string) || null,
      productTitle: (formData.get("productTitle") as string) || null,
      productImageUrl: (formData.get("productImageUrl") as string) || null,
      moment: moment.trim(),
      contentType: contentType as any,
      maxSubmissions,
      startDate,
      endDate,
      captureSpecs,
      status: saveAsDraft ? "DRAFT" : "ACTIVE",
      ...rewardData,
    },
  });

  if (saveAsDraft) {
    return redirect(`/app/campaigns/${campaign.id}`);
  }
  return redirect(`/app/campaigns/${campaign.id}/live`);
};

// ── Stepper component ───────────────────────────────────────────
function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <Box paddingBlockEnd="600">
      <InlineStack align="center" gap="100">
        {STEPS.map((step, i) => {
          const isComplete = i < currentStep;
          const isCurrent = i === currentStep;
          return (
            <InlineStack key={step.key} gap="100" blockAlign="center">
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "13px",
                  fontWeight: 600,
                  background: isComplete || isCurrent ? "#1a1a1a" : "#e5e7eb",
                  color: isComplete || isCurrent ? "#fff" : "#6b7280",
                }}
              >
                {isComplete ? "✓" : i + 1}
              </div>
              <Text as="span" variant="bodySm" fontWeight={isCurrent ? "bold" : "regular"} tone={isCurrent ? undefined : "subdued"}>
                {step.label}
              </Text>
              {i < STEPS.length - 1 && (
                <div style={{ width: 40, height: 1, background: isComplete ? "#1a1a1a" : "#e5e7eb" }} />
              )}
            </InlineStack>
          );
        })}
      </InlineStack>
    </Box>
  );
}

// ── Helper: format reward text ──────────────────────────────────
function frequencyUnit(freq: string, count: number): string {
  const units: Record<string, [string, string]> = {
    DAY: ["day", "days"], WEEK: ["week", "weeks"], MONTH: ["month", "months"],
  };
  const [singular, plural] = units[freq] || units.MONTH;
  return count === 1 ? singular : plural;
}

function formatSubscriptionReward(discountType: string, discountValue: string, rewardCycles: number, rewardFrequency: string = "MONTH"): string {
  const unit = `${rewardCycles} ${frequencyUnit(rewardFrequency, rewardCycles)}`;
  if (discountType === "FREE") return `Free for ${unit}`;
  if (discountType === "FIXED_AMOUNT") return `$${discountValue} off × ${unit}`;
  if (discountType === "PERCENTAGE") return `${discountValue}% off × ${unit}`;
  return unit;
}

function formatDiscountCodeReward(amount: number, type: string, expiryDays?: number | null): string {
  const discountText = type === "PERCENTAGE" ? `${amount}% off` : `$${amount} off`;
  const expiryText = expiryDays ? ` (expires in ${expiryDays} days)` : "";
  return `${discountText} discount code${expiryText}`;
}

// ── Main component ──────────────────────────────────────────────
export default function NewCampaignWizard() {
  const { providerConnected } = useLoaderData<typeof loader>();

  const navigation = useNavigation();
  const submit = useSubmit();
  const actionData = useActionData<typeof action>();
  const isSubmitting = navigation.state === "submitting";

  const [step, setStep] = useState(0);

  // Campaign fields
  const [title, setTitle] = useState("");
  const [contentType, setContentType] = useState("VIDEO");
  const [moment, setMoment] = useState("");

  // Requirements
  const [requirements, setRequirements] = useState<string[]>([]);
  const [newRequirement, setNewRequirement] = useState("");

  // Production specs (fixed set)
  const [orientation, setOrientation] = useState("portrait");
  const [duration, setDuration] = useState("15-60");
  const [quality, setQuality] = useState("1080p");
  const [format, setFormat] = useState("mp4");
  const [aspectRatio, setAspectRatio] = useState("9:16");

  // Reference scene
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);

  // Reward type
  const [rewardType, setRewardType] = useState<"DISCOUNT_CODE" | "SUBSCRIPTION_DISCOUNT">("DISCOUNT_CODE");
  const [hasSellingPlan, setHasSellingPlan] = useState(false);
  const [checkingSellingPlan, setCheckingSellingPlan] = useState(false);

  // Discount code fields
  const [discountCodeAmount, setDiscountCodeAmount] = useState("");
  const [discountCodeType, setDiscountCodeType] = useState("PERCENTAGE");
  const [discountCodeExpiryDays, setDiscountCodeExpiryDays] = useState("30");
  const [discountCodeMinOrder, setDiscountCodeMinOrder] = useState("");

  // Subscription discount fields (existing)
  const [discountType, setDiscountType] = useState("FREE");
  const [discountValue, setDiscountValue] = useState("");
  const [rewardCycles, setRewardCycles] = useState(1);
  const [rewardFrequency, setRewardFrequency] = useState("MONTH");

  // Limits
  const [hasMaxSubmissions, setHasMaxSubmissions] = useState(false);
  const [maxSubmissions, setMaxSubmissions] = useState("");
  const [hasDateRange, setHasDateRange] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Rights
  const [rightsAcknowledged, setRightsAcknowledged] = useState(false);

  // Product
  const [productId, setProductId] = useState("");
  const [productTitle, setProductTitle] = useState("");
  const [productImageUrl, setProductImageUrl] = useState("");
  const shopify = useAppBridge();

  // Check for selling plans when a product is selected
  useEffect(() => {
    if (!productId) {
      setHasSellingPlan(false);
      return;
    }
    setCheckingSellingPlan(true);
    fetch(`/app/api/check-selling-plans?productId=${encodeURIComponent(productId)}`)
      .then((res) => res.json())
      .then((data) => {
        console.log("[UGME] check-selling-plans result:", data);
        setHasSellingPlan(data.hasSellingPlans ?? false);
        setCheckingSellingPlan(false);
      })
      .catch(() => {
        setHasSellingPlan(false);
        setCheckingSellingPlan(false);
      });
  }, [productId]);

  const handleProductSelect = useCallback(async () => {
    try {
      const selected = await shopify.resourcePicker({
          type: "product",
          multiple: false,
          selectionIds: productId ? [{ id: productId }] : [],
          filter: { variants: false },
        });
      if (selected && selected.length > 0) {
        const product = selected[0];
        setProductId(product.id);
        setProductTitle(product.title);
        setProductImageUrl(product.images?.[0]?.originalSrc || "");
        // Reset reward type when product changes
        setRewardType("DISCOUNT_CODE");
      }
    } catch (e) {
      // User cancelled picker
    }
  }, [shopify]);

  // Helpers
  const addRequirement = useCallback(() => {
    if (newRequirement.trim()) {
      setRequirements((prev) => [...prev, newRequirement.trim()]);
      setNewRequirement("");
    }
  }, [newRequirement]);

  const removeRequirement = useCallback((index: number) => {
    setRequirements((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleReferenceDrop = useCallback((_: File[], acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const file = acceptedFiles[0];
      setReferenceFile(file);
      setReferencePreview(URL.createObjectURL(file));
    }
  }, []);

  const removeReference = useCallback(() => {
    setReferenceFile(null);
    setReferencePreview(null);
  }, []);

  const canAdvance = useCallback(() => {
    switch (step) {
      case 0: {
        // Product & Reward: product selected + reward configured
        if (!productId) return false;
        if (rewardType === "DISCOUNT_CODE") {
          return parseFloat(discountCodeAmount) > 0;
        }
        // Subscription discount
        if (discountType === "FREE") return rewardCycles >= 1;
        if (discountType === "FIXED_AMOUNT") return rewardCycles >= 1 && parseFloat(discountValue) > 0;
        if (discountType === "PERCENTAGE") return rewardCycles >= 1 && parseFloat(discountValue) > 0 && parseFloat(discountValue) <= 100;
        return false;
      }
      case 1: return title.trim().length > 0 && moment.trim().length > 0;
      case 2: return rightsAcknowledged;
      case 3: return true;
      default: return false;
    }
  }, [step, title, moment, productId, rewardType, discountCodeAmount, rewardCycles, discountType, discountValue, rightsAcknowledged]);

  // Build specs array from the fixed fields
  const buildSpecs = useCallback(() => {
    const specs: Array<{ label: string; description: string }> = [
      { label: "Orientation", description: orientation === "portrait" ? "Portrait (vertical)" : orientation === "landscape" ? "Landscape (horizontal)" : "Any orientation" },
      { label: "Aspect ratio", description: aspectRatio === "any" ? "Any" : aspectRatio },
      { label: "Quality", description: quality },
      { label: "Format", description: format.toUpperCase() },
    ];
    if (contentType === "VIDEO") {
      const durationMap: Record<string, string> = {
        "15-30": "15–30 seconds",
        "15-60": "15–60 seconds",
        "30-90": "30–90 seconds",
        "60-180": "1–3 minutes",
      };
      specs.splice(1, 0, { label: "Duration", description: durationMap[duration] || duration });
    }
    return specs;
  }, [orientation, aspectRatio, quality, format, contentType, duration]);

  // Reward label for display
  const rewardLabel = rewardType === "DISCOUNT_CODE"
    ? formatDiscountCodeReward(
        parseFloat(discountCodeAmount) || 0,
        discountCodeType,
        discountCodeExpiryDays ? parseInt(discountCodeExpiryDays) : null,
      )
    : formatSubscriptionReward(discountType, discountValue, rewardCycles, rewardFrequency);

  const handlePublish = useCallback(
    (asDraft: boolean) => {
      const allSpecs = [
        ...buildSpecs(),
        ...requirements.map((r) => ({ label: "Requirement", description: r })),
      ];
      const formData = new FormData();
      formData.set("title", title);
      if (productId) formData.set("productId", productId);
      if (productTitle) formData.set("productTitle", productTitle);
      if (productImageUrl) formData.set("productImageUrl", productImageUrl);
      formData.set("moment", moment);
      formData.set("contentType", contentType);
      formData.set("rewardType", rewardType);

      if (rewardType === "DISCOUNT_CODE") {
        formData.set("discountCodeAmount", discountCodeAmount || "0");
        formData.set("discountCodeType", discountCodeType);
        if (discountCodeExpiryDays) formData.set("discountCodeExpiryDays", discountCodeExpiryDays);
        if (discountCodeMinOrder) formData.set("discountCodeMinOrder", discountCodeMinOrder);
      } else {
        formData.set("discountType", discountType);
        formData.set("discountValue", discountType === "FREE" ? "0" : discountValue);
        formData.set("rewardCycles", String(rewardCycles));
        formData.set("rewardFrequency", rewardFrequency);
      }

      if (hasMaxSubmissions && maxSubmissions) formData.set("maxSubmissions", maxSubmissions);
      if (hasDateRange) {
        if (startDate) formData.set("startDate", startDate);
        if (endDate) formData.set("endDate", endDate);
      }
      if (allSpecs.length > 0) formData.set("captureSpecs", JSON.stringify(allSpecs));
      formData.set("saveAsDraft", String(asDraft));
      submit(formData, { method: "post" });
    },
    [title, moment, contentType, rewardType, discountCodeAmount, discountCodeType, discountCodeExpiryDays, discountCodeMinOrder, discountType, discountValue, rewardCycles, rewardFrequency, maxSubmissions, startDate, endDate, hasDateRange, hasMaxSubmissions, buildSpecs, requirements, submit, productId, productTitle, productImageUrl],
  );

  // ── Step 0: Product & Reward ───────────────────────────────────
  const renderStepProductReward = () => (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
          {/* Product selection */}
          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">Product</Text>
              <Text as="p" tone="subdued">
                Select the product this campaign is for. Customers will submit content featuring this product.
              </Text>
              {productTitle ? (
                <InlineStack gap="400" blockAlign="center">
                  {productImageUrl ? (
                    <div style={{ width: 64, height: 64, borderRadius: 8, overflow: "hidden", background: "#f3f3f3", flexShrink: 0 }}>
                      <img src={productImageUrl} alt={productTitle} style={{ width: 64, height: 64, objectFit: "cover", display: "block" }} />
                    </div>
                  ) : (
                    <div style={{ width: 64, height: 64, borderRadius: 8, background: "#f3f3f3", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Text as="span" tone="subdued">No img</Text>
                    </div>
                  )}
                  <Box width="100%">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{productTitle}</Text>
                      <Button variant="plain" onClick={handleProductSelect} size="slim">Change product</Button>
                    </BlockStack>
                  </Box>
                </InlineStack>
              ) : (
                <Button onClick={handleProductSelect}>Select product</Button>
              )}
            </BlockStack>
          </Card>

          {/* Reward type selector */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">Choose reward type</Text>
              <Text as="p" tone="subdued">
                Select how you want to reward customers for their content submissions.
              </Text>

              <BlockStack gap="300">
                {/* Discount code option - always available */}
                <div
                  onClick={() => setRewardType("DISCOUNT_CODE")}
                  style={{
                    padding: "16px",
                    border: `2px solid ${rewardType === "DISCOUNT_CODE" ? "#1a1a1a" : "#e5e7eb"}`,
                    borderRadius: "12px",
                    cursor: "pointer",
                    background: rewardType === "DISCOUNT_CODE" ? "#f9fafb" : "#fff",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%",
                      border: `2px solid ${rewardType === "DISCOUNT_CODE" ? "#1a1a1a" : "#d1d5db"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      marginTop: 2, flexShrink: 0,
                    }}>
                      {rewardType === "DISCOUNT_CODE" && (
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#1a1a1a" }} />
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">Discount code</Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Generate a unique discount code for the customer to use on their next order at your store.
                      </Text>
                    </div>
                  </div>
                </div>

                {/* Subscription discount option - conditionally available */}
                <div
                  onClick={() => {
                    if (hasSellingPlan && providerConnected) setRewardType("SUBSCRIPTION_DISCOUNT");
                  }}
                  style={{
                    padding: "16px",
                    border: `2px solid ${rewardType === "SUBSCRIPTION_DISCOUNT" ? "#1a1a1a" : "#e5e7eb"}`,
                    borderRadius: "12px",
                    cursor: hasSellingPlan && providerConnected ? "pointer" : "not-allowed",
                    background: rewardType === "SUBSCRIPTION_DISCOUNT" ? "#f9fafb" : "#fff",
                    opacity: hasSellingPlan && providerConnected ? 1 : 0.6,
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%",
                      border: `2px solid ${rewardType === "SUBSCRIPTION_DISCOUNT" ? "#1a1a1a" : "#d1d5db"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      marginTop: 2, flexShrink: 0,
                    }}>
                      {rewardType === "SUBSCRIPTION_DISCOUNT" && (
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#1a1a1a" }} />
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">Subscription discount</Text>
                        {!(hasSellingPlan && providerConnected) && <Badge tone="info">Unavailable</Badge>}
                      </div>
                      {hasSellingPlan && providerConnected ? (
                        <Text as="span" variant="bodySm" tone="subdued">
                          Apply a discount to the customer's subscription payments (free months, percentage off, etc).
                        </Text>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {!hasSellingPlan
                            ? "No subscription plan detected for this product. Connect your provider in "
                            : "Connect your subscription provider in "}
                          <Link to="/app/settings">Settings</Link>
                          {" to enable this option."}
                        </Text>
                      )}
                    </div>
                  </div>
                </div>
              </BlockStack>
            </BlockStack>
          </Card>

          {/* Reward configuration based on type */}
          {rewardType === "DISCOUNT_CODE" ? (
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingLg">Configure discount code</Text>

                {/* Discount code type selector */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">Discount type</Text>
                  <ButtonGroup variant="segmented">
                    <Button pressed={discountCodeType === "PERCENTAGE"} onClick={() => setDiscountCodeType("PERCENTAGE")}>
                      % off
                    </Button>
                    <Button pressed={discountCodeType === "FIXED_AMOUNT"} onClick={() => setDiscountCodeType("FIXED_AMOUNT")}>
                      $ amount off
                    </Button>
                  </ButtonGroup>
                </BlockStack>

                <TextField
                  label={discountCodeType === "PERCENTAGE" ? "Percentage off" : "Amount off ($)"}
                  type="number"
                  value={discountCodeAmount}
                  onChange={setDiscountCodeAmount}
                  placeholder={discountCodeType === "PERCENTAGE" ? "e.g. 20" : "e.g. 15"}
                  prefix={discountCodeType === "FIXED_AMOUNT" ? "$" : undefined}
                  suffix={discountCodeType === "PERCENTAGE" ? "%" : undefined}
                  min={1}
                  max={discountCodeType === "PERCENTAGE" ? 100 : undefined}
                  autoComplete="off"
                />

                <Divider />

                <TextField
                  label="Code expiry (optional)"
                  type="number"
                  value={discountCodeExpiryDays}
                  onChange={setDiscountCodeExpiryDays}
                  placeholder="e.g. 30"
                  helpText="How many days the customer has to use their code after approval. Leave blank for no expiry."
                  min={1}
                  autoComplete="off"
                />

                <TextField
                  label="Minimum order amount (optional)"
                  type="number"
                  value={discountCodeMinOrder}
                  onChange={setDiscountCodeMinOrder}
                  placeholder="e.g. 50"
                  prefix="$"
                  helpText="Minimum order subtotal required to use the code. Leave blank for no minimum."
                  min={0}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingLg">Configure subscription discount</Text>

                {/* Discount type selector */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">Discount type</Text>
                  <ButtonGroup variant="segmented">
                    <Button pressed={discountType === "FREE"} onClick={() => { setDiscountType("FREE"); setDiscountValue(""); }}>
                      Free
                    </Button>
                    <Button pressed={discountType === "FIXED_AMOUNT"} onClick={() => setDiscountType("FIXED_AMOUNT")}>
                      $ amount off
                    </Button>
                    <Button pressed={discountType === "PERCENTAGE"} onClick={() => setDiscountType("PERCENTAGE")}>
                      % off
                    </Button>
                  </ButtonGroup>
                </BlockStack>

                {/* Discount value (only for non-free) */}
                {discountType !== "FREE" && (
                  <TextField
                    label={discountType === "FIXED_AMOUNT" ? `Amount off per ${rewardFrequency === "DAY" ? "day" : rewardFrequency === "WEEK" ? "week" : "month"} ($)` : "Percentage off"}
                    type="number"
                    value={discountValue}
                    onChange={setDiscountValue}
                    placeholder={discountType === "FIXED_AMOUNT" ? "e.g. 10" : "e.g. 50"}
                    prefix={discountType === "FIXED_AMOUNT" ? "$" : undefined}
                    suffix={discountType === "PERCENTAGE" ? "%" : undefined}
                    min={1}
                    max={discountType === "PERCENTAGE" ? 100 : undefined}
                    autoComplete="off"
                  />
                )}

                {/* Duration */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">Duration</Text>
                  <RangeSlider
                    label={`${rewardCycles} ${rewardCycles !== 1 ? (rewardFrequency === "DAY" ? "days" : rewardFrequency === "WEEK" ? "weeks" : "months") : (rewardFrequency === "DAY" ? "day" : rewardFrequency === "WEEK" ? "week" : "month")}`}
                    value={rewardCycles}
                    min={1}
                    max={12}
                    step={1}
                    onChange={(value) => setRewardCycles(value as number)}
                    output
                  />
                  <Text as="p" tone="subdued">
                    The discount applies for this many months after you approve their submission.
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </Layout.Section>

      <Layout.Section variant="oneThird">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Reward summary</Text>
            <Divider />
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">Reward type</Text>
              <Badge>{rewardType === "DISCOUNT_CODE" ? "Discount code" : "Subscription discount"}</Badge>
            </InlineStack>

            {rewardType === "DISCOUNT_CODE" ? (
              <>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Discount</Text>
                  <Text as="span" fontWeight="bold">
                    {discountCodeAmount
                      ? (discountCodeType === "PERCENTAGE" ? `${discountCodeAmount}%` : `$${discountCodeAmount}`)
                      : "—"}
                  </Text>
                </InlineStack>
                {discountCodeExpiryDays && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Expires</Text>
                    <Text as="span">{discountCodeExpiryDays} days</Text>
                  </InlineStack>
                )}
                {discountCodeMinOrder && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Min. order</Text>
                    <Text as="span">${discountCodeMinOrder}</Text>
                  </InlineStack>
                )}
              </>
            ) : (
              <>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Type</Text>
                  <Text as="span" fontWeight="bold">
                    {discountType === "FREE" ? "Free" : discountType === "FIXED_AMOUNT" ? "Fixed amount" : "Percentage"}
                  </Text>
                </InlineStack>
                {discountType !== "FREE" && discountValue && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Discount</Text>
                    <Text as="span" fontWeight="bold">
                      {discountType === "FIXED_AMOUNT" ? `$${discountValue}/mo` : `${discountValue}%`}
                    </Text>
                  </InlineStack>
                )}
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Duration</Text>
                  <Text as="span" fontWeight="bold">
                    {formatSubscriptionReward(discountType, discountValue, rewardCycles, rewardFrequency)}
                  </Text>
                </InlineStack>
              </>
            )}

            <Divider />
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">Per submission</Text>
              <Badge tone="success">{rewardLabel}</Badge>
            </InlineStack>
            {hasMaxSubmissions && maxSubmissions && (
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">Max submissions</Text>
                <Text as="span">{maxSubmissions}</Text>
              </InlineStack>
            )}
            {hasDateRange && startDate && endDate && (
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">Campaign window</Text>
                <Text as="span">
                  {Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24))} days
                </Text>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>
    </Layout>
  );

  // ── Step 1: Campaign Details ──────────────────────────────────
  const renderStepCampaign = () => (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
          {/* Core info */}
          <Card>
            <BlockStack gap="400">
              <TextField
                label="Campaign title"
                value={title}
                onChange={setTitle}
                placeholder="e.g. Syrup Into Coffee"
                autoComplete="off"
              />

              <BlockStack gap="200">
                <Text as="span" variant="bodyMd" fontWeight="semibold">Content type</Text>
                <ButtonGroup variant="segmented">
                  <Button pressed={contentType === "VIDEO"} onClick={() => setContentType("VIDEO")}>
                    Video
                  </Button>
                  <Button pressed={contentType === "PHOTO"} onClick={() => setContentType("PHOTO")}>
                    Photo
                  </Button>
                </ButtonGroup>
              </BlockStack>

              <TextField
                label="Creative moment"
                value={moment}
                onChange={setMoment}
                placeholder="e.g. Pouring our syrup into your morning coffee"
                helpText="Describe what you want customers to capture."
                multiline={3}
                autoComplete="off"
              />
            </BlockStack>
          </Card>

          {/* Content requirements */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Content requirements</Text>
              {requirements.length > 0 && (
                <BlockStack gap="200">
                  {requirements.map((req, i) => (
                    <InlineStack key={i} gap="200" blockAlign="center">
                      <Box minWidth="0" width="100%">
                        <Text as="span">{req}</Text>
                      </Box>
                      <Button variant="plain" tone="critical" onClick={() => removeRequirement(i)} size="slim">
                        Remove
                      </Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
              <InlineStack gap="200" blockAlign="end">
                <Box width="100%">
                  <TextField
                    label="Add a requirement"
                    labelHidden
                    value={newRequirement}
                    onChange={setNewRequirement}
                    placeholder="e.g. Product label must be visible"
                    autoComplete="off"
                    
                  />
                </Box>
                <Button onClick={addRequirement} disabled={!newRequirement.trim()} size="slim">
                  Add
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Production specs (fixed) */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Production specs</Text>
              <FormLayout>
                <FormLayout.Group>
                  <Select
                    label="Orientation"
                    options={[
                      { label: "Portrait (vertical)", value: "portrait" },
                      { label: "Landscape (horizontal)", value: "landscape" },
                      { label: "Either", value: "either" },
                    ]}
                    value={orientation}
                    onChange={setOrientation}
                  />
                  <Select
                    label="Aspect ratio"
                    options={[
                      { label: "9:16", value: "9:16" },
                      { label: "16:9", value: "16:9" },
                      { label: "1:1 (Square)", value: "1:1" },
                      { label: "4:5", value: "4:5" },
                      { label: "Any", value: "any" },
                    ]}
                    value={aspectRatio}
                    onChange={setAspectRatio}
                  />
                </FormLayout.Group>
                <FormLayout.Group>
                  {contentType === "VIDEO" && (
                    <Select
                      label="Duration"
                      options={[
                        { label: "15–30 seconds", value: "15-30" },
                        { label: "15–60 seconds", value: "15-60" },
                        { label: "30–90 seconds", value: "30-90" },
                        { label: "1–3 minutes", value: "60-180" },
                      ]}
                      value={duration}
                      onChange={setDuration}
                    />
                  )}
                  <Select
                    label="Quality"
                    options={[
                      { label: "720p", value: "720p" },
                      { label: "1080p (recommended)", value: "1080p" },
                      { label: "4K", value: "4k" },
                    ]}
                    value={quality}
                    onChange={setQuality}
                  />
                  <Select
                    label="Format"
                    options={
                      contentType === "VIDEO"
                        ? [
                            { label: "MP4", value: "mp4" },
                            { label: "MOV", value: "mov" },
                            { label: "Any", value: "any" },
                          ]
                        : [
                            { label: "JPG", value: "jpg" },
                            { label: "PNG", value: "png" },
                            { label: "Any", value: "any" },
                          ]
                    }
                    value={format}
                    onChange={setFormat}
                  />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>
          </Card>

          {/* Reference scene */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Reference scene (optional)</Text>
              <Text as="p" tone="subdued">
                Upload an example {contentType === "VIDEO" ? "video" : "image"} to show customers the vibe you are going for.
              </Text>
              {referencePreview ? (
                <BlockStack gap="300">
                  <Box borderRadius="200" >
                    <img
                      src={referencePreview}
                      alt="Reference scene"
                      style={{ width: "100%", maxHeight: "300px", objectFit: "cover", display: "block", borderRadius: "8px" }}
                    />
                  </Box>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" tone="subdued">{referenceFile?.name}</Text>
                    <Button variant="plain" tone="critical" onClick={removeReference} size="slim">
                      Remove
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : (
                <DropZone
                  accept={contentType === "VIDEO" ? "video/*" : "image/*"}
                  type={contentType === "VIDEO" ? "video" : "image"}
                  onDrop={handleReferenceDrop}
                  allowMultiple={false}
                >
                  <DropZone.FileUpload actionHint={`or drop ${contentType === "VIDEO" ? "a video" : "an image"}`} />
                </DropZone>
              )}
            </BlockStack>
          </Card>

          {/* Limits - shared for both reward types */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Limits</Text>
              <Checkbox
                label="Set a submission cap"
                checked={hasMaxSubmissions}
                onChange={setHasMaxSubmissions}
              />
              {hasMaxSubmissions && (
                <TextField
                  label="Maximum submissions"
                  type="number"
                  value={maxSubmissions}
                  onChange={setMaxSubmissions}
                  placeholder="e.g. 50"
                  min={1}
                  autoComplete="off"
                />
              )}
              <Checkbox
                label="Set a date range"
                checked={hasDateRange}
                onChange={setHasDateRange}
              />
              {hasDateRange && (
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Start date"
                      type="date"
                      value={startDate}
                      onChange={setStartDate}
                      autoComplete="off"
                    />
                    <TextField
                      label="End date"
                      type="date"
                      value={endDate}
                      onChange={setEndDate}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                </FormLayout>
              )}
            </BlockStack>
          </Card>
        </BlockStack>
      </Layout.Section>

      {/* Sidebar preview */}
      <Layout.Section variant="oneThird">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Preview</Text>
            <Divider />
            {productImageUrl && (
              <Box borderRadius="200" >
                <img src={productImageUrl} alt={productTitle} style={{ width: "100%", maxHeight: 140, objectFit: "contain", display: "block", borderRadius: 8, background: "#f9fafb" }} />
              </Box>
            )}
            <InlineStack gap="200" blockAlign="center">
              <Text as="p" variant="headingSm">{title || "Campaign title"}</Text>
              <Badge>{contentType === "VIDEO" ? "Video" : "Photo"}</Badge>
            </InlineStack>
            {productTitle && (
              <Text as="p" variant="bodySm" tone="subdued">Product: {productTitle}</Text>
            )}
            <Text as="p" tone={moment ? undefined : "subdued"}>
              {moment || "Your creative moment..."}
            </Text>
            {requirements.length > 0 && (
              <>
                <Divider />
                <BlockStack gap="100">
                  {requirements.map((r, i) => (
                    <Text key={i} as="p" variant="bodySm" tone="subdued">{r}</Text>
                  ))}
                </BlockStack>
              </>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>
    </Layout>
  );

  // ── Step 2: Rights ────────────────────────────────────────────
  const renderStepRights = () => (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">Content usage rights</Text>
              <Text as="p" tone="subdued">
                Submitters will be required to agree to the following usage rights before uploading their content.
                This protects your brand and ensures you can use the content across your marketing channels.
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">Usage rights agreement</Text>
              <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  <Text as="p" fontWeight="semibold">By submitting content, the creator agrees that:</Text>

                  <BlockStack gap="200">
                    <Text as="p">1. The content is original and was created by them.</Text>
                    <Text as="p">2. They grant the brand a perpetual, non-exclusive, royalty-free license to use, reproduce, modify, and distribute the content.</Text>
                    <Text as="p">3. The brand may use the content on social media, websites, email marketing, paid advertising, and any other marketing channels.</Text>
                    <Text as="p">4. The brand may edit, crop, or modify the content to fit different formats and platforms.</Text>
                    <Text as="p">5. The creator retains ownership of the original content and may continue to use it personally.</Text>
                    <Text as="p">6. The creator waives any right to inspect or approve the final use of the content.</Text>
                    <Text as="p">7. The creator confirms they have the rights to any people, locations, or properties featured in the content.</Text>
                  </BlockStack>

                  <Divider />

                  <Text as="p" tone="subdued" variant="bodySm">
                    This is a standard content license agreement. A full legal terms document will be generated for your campaign
                    that submitters must accept before uploading. You will be able to customize specific terms in a future update.
                  </Text>
                </BlockStack>
              </Box>
            </BlockStack>
          </Card>

          <Card>
            <Checkbox
              label="I have reviewed and accept these usage rights for my campaign"
              checked={rightsAcknowledged}
              onChange={setRightsAcknowledged}
            />
          </Card>
        </BlockStack>
      </Layout.Section>

      <Layout.Section variant="oneThird">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Why this matters</Text>
            <Divider />
            <Text as="p" variant="bodySm">
              Clear usage rights protect both you and your customers. Without them,
              you may not be able to legally use submitted content in ads or on social media.
            </Text>
            <Text as="p" variant="bodySm">
              These terms are industry-standard for user-generated content campaigns
              and are designed to be fair to both parties.
            </Text>
          </BlockStack>
        </Card>
      </Layout.Section>
    </Layout>
  );

  // ── Step 3: Review ────────────────────────────────────────────
  const renderStepReview = () => {
    const prodSpecs = buildSpecs();
    return (
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingLg">Review &amp; launch</Text>
                  <InlineStack gap="200">
                    <Button onClick={() => handlePublish(true)} loading={isSubmitting}>
                      Save draft
                    </Button>
                    <Button variant="primary" tone="success" onClick={() => handlePublish(false)} loading={isSubmitting}>
                      Activate campaign
                    </Button>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </Card>

            {actionData?.error && (
              <Banner tone="critical">{actionData.error}</Banner>
            )}

            {/* Campaign summary */}
            <Card>
              <BlockStack gap="300">
                {productImageUrl && (
                  <Box borderRadius="200" >
                    <img src={productImageUrl} alt={productTitle} style={{ width: "100%", maxHeight: 180, objectFit: "contain", display: "block", borderRadius: 8, background: "#f9fafb" }} />
                  </Box>
                )}
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">{title}</Text>
                  <Badge>{contentType === "VIDEO" ? "Video" : "Photo"}</Badge>
                </InlineStack>
                {productTitle && (
                  <Text as="p" variant="bodySm" tone="subdued">Product: {productTitle}</Text>
                )}
                <Text as="p">{moment}</Text>

                {requirements.length > 0 && (
                  <>
                    <Divider />
                    <Text as="p" fontWeight="semibold">Requirements</Text>
                    {requirements.map((r, i) => (
                      <Text key={i} as="p">{r}</Text>
                    ))}
                  </>
                )}
              </BlockStack>
            </Card>

            {/* Production specs */}
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Production specs</Text>
                <Divider />
                {prodSpecs.map((s, i) => (
                  <InlineStack key={i} align="space-between">
                    <Text as="span" tone="subdued">{s.label}</Text>
                    <Text as="span">{s.description}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>

            {/* Reference scene */}
            {referencePreview && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">Reference scene</Text>
                  <Box borderRadius="200" >
                    <img
                      src={referencePreview}
                      alt="Reference"
                      style={{ width: "100%", maxHeight: "200px", objectFit: "cover", display: "block", borderRadius: "8px" }}
                    />
                  </Box>
                </BlockStack>
              </Card>
            )}

            {/* Reward summary */}
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Reward</Text>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Type</Text>
                  <Badge>{rewardType === "DISCOUNT_CODE" ? "Discount code" : "Subscription discount"}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Per submission</Text>
                  <Badge tone="success">{rewardLabel}</Badge>
                </InlineStack>
                {hasMaxSubmissions && maxSubmissions && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Submission cap</Text>
                    <Text as="span">{maxSubmissions}</Text>
                  </InlineStack>
                )}
                {hasDateRange && (startDate || endDate) && (
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">Date range</Text>
                    <Text as="span">
                      {startDate ? new Date(startDate).toLocaleDateString() : "Open"} — {endDate ? new Date(endDate).toLocaleDateString() : "Open"}
                    </Text>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            {/* Rights confirmation */}
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Usage rights</Text>
                <Divider />
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">Accepted</Badge>
                  <Text as="span" tone="subdued">Standard content license agreement</Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Customer preview sidebar */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Customer preview</Text>
              <Divider />
              <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  {productImageUrl && (
                    <img src={productImageUrl} alt={productTitle} style={{ width: "100%", maxHeight: 120, objectFit: "contain", display: "block", borderRadius: 8, background: "#fff" }} />
                  )}
                  <Text as="p" variant="headingSm">{title}</Text>
                  <Text as="p">{moment}</Text>
                  <Divider />
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="success">{rewardLabel}</Badge>
                  </InlineStack>
                  <Box padding="300" background="bg-surface" borderRadius="200">
                    <Text as="p" alignment="center" tone="subdued">
                      [ Submit your {contentType === "VIDEO" ? "video" : "photo"} ]
                    </Text>
                  </Box>
                </BlockStack>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    );
  };

  const stepRenderers = [renderStepProductReward, renderStepCampaign, renderStepRights, renderStepReview];

  return (
    <Page
      backAction={{ content: "Campaigns", url: "/app/campaigns" }}
      title="New campaign"
    >
      <Stepper currentStep={step} />
      {stepRenderers[step]()}

      <Box paddingBlockStart="600" paddingBlockEnd="600">
        <InlineStack align="space-between">
          <div>
            {step > 0 && (
              <Button onClick={() => setStep((s) => s - 1)}>
                Back
              </Button>
            )}
          </div>
          <div>
            {step < STEPS.length - 1 && (
              <Button
                variant="primary"
                onClick={() => setStep((s) => s + 1)}
                disabled={!canAdvance()}
              >
                Continue
              </Button>
            )}
          </div>
        </InlineStack>
      </Box>
    </Page>
  );
}
