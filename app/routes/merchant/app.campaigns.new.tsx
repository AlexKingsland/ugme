import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useSubmit, useNavigation, useActionData } from "@remix-run/react";
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
import { useState, useCallback } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

// ── Step definitions ────────────────────────────────────────────
const STEPS = [
  { key: "campaign", label: "Campaign" },
  { key: "reward", label: "Reward" },
  { key: "rights", label: "Rights" },
  { key: "review", label: "Review" },
] as const;

// ── Loader / Action ─────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
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
  const discountType = formData.get("discountType") as string;
  const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
  const rewardMonths = parseInt(formData.get("rewardMonths") as string, 10) || 1;
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
  if (rewardMonths < 1 || rewardMonths > 12) errors.push("Reward months must be 1-12.");
  if (discountType === "FIXED_AMOUNT" && discountValue <= 0) errors.push("Discount amount must be greater than 0.");
  if (discountType === "PERCENTAGE" && (discountValue <= 0 || discountValue > 100)) errors.push("Discount percentage must be between 1-100.");
  if (startDate && endDate && endDate <= startDate) errors.push("End date must be after start date.");
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
      discountType: discountType as any,
      discountValue,
      rewardMonths,
      maxSubmissions,
      startDate,
      endDate,
      captureSpecs,
      status: saveAsDraft ? "DRAFT" : "ACTIVE",
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
function formatReward(discountType: string, discountValue: string, rewardMonths: number): string {
  const months = `${rewardMonths} month${rewardMonths !== 1 ? "s" : ""}`;
  if (discountType === "FREE") return `Free for ${months}`;
  if (discountType === "FIXED_AMOUNT") return `$${discountValue}/mo off for ${months}`;
  if (discountType === "PERCENTAGE") return `${discountValue}% off for ${months}`;
  return months;
}

// ── Main component ──────────────────────────────────────────────
export default function NewCampaignWizard() {
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

  // Reward
  const [discountType, setDiscountType] = useState("FREE");
  const [discountValue, setDiscountValue] = useState("");
  const [rewardMonths, setRewardMonths] = useState(1);
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
      case 0: return title.trim().length > 0 && moment.trim().length > 0 && productId.length > 0;
      case 1: {
        if (discountType === "FREE") return rewardMonths >= 1;
        if (discountType === "FIXED_AMOUNT") return rewardMonths >= 1 && parseFloat(discountValue) > 0;
        if (discountType === "PERCENTAGE") return rewardMonths >= 1 && parseFloat(discountValue) > 0 && parseFloat(discountValue) <= 100;
        return false;
      }
      case 2: return rightsAcknowledged;
      case 3: return true;
      default: return false;
    }
  }, [step, title, moment, rewardMonths, discountType, discountValue, rightsAcknowledged]);

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

  const rewardLabel = formatReward(discountType, discountValue, rewardMonths);

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
      formData.set("discountType", discountType);
      formData.set("discountValue", discountType === "FREE" ? "0" : discountValue);
      formData.set("rewardMonths", String(rewardMonths));
      if (hasMaxSubmissions && maxSubmissions) formData.set("maxSubmissions", maxSubmissions);
      if (hasDateRange) {
        if (startDate) formData.set("startDate", startDate);
        if (endDate) formData.set("endDate", endDate);
      }
      if (allSpecs.length > 0) formData.set("captureSpecs", JSON.stringify(allSpecs));
      formData.set("saveAsDraft", String(asDraft));
      submit(formData, { method: "post" });
    },
    [title, moment, contentType, discountType, discountValue, rewardMonths, maxSubmissions, startDate, endDate, hasDateRange, hasMaxSubmissions, buildSpecs, requirements, submit],
  );

  // ── Step 0: Campaign ──────────────────────────────────────────
  const renderStepCampaign = () => (
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
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); addRequirement(); } }}
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

  // ── Step 1: Reward ────────────────────────────────────────────
  const renderStepReward = () => (
    <Layout>
      <Layout.Section>
        <Card>
          <BlockStack gap="500">
            <Text as="h2" variant="headingLg">Set the reward</Text>

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
                label={discountType === "FIXED_AMOUNT" ? "Amount off per month ($)" : "Percentage off"}
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
                label={`${rewardMonths} month${rewardMonths !== 1 ? "s" : ""}`}
                value={rewardMonths}
                min={1}
                max={12}
                step={1}
                onChange={(value) => setRewardMonths(value as number)}
                output
              />
              <Text as="p" tone="subdued">
                The discount applies for this many months after you approve their submission.
              </Text>
            </BlockStack>

            <Divider />

            {/* Limits */}
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
          </BlockStack>
        </Card>
      </Layout.Section>

      <Layout.Section variant="oneThird">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">Reward summary</Text>
            <Divider />
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
              <Text as="span" fontWeight="bold">{rewardMonths} month{rewardMonths !== 1 ? "s" : ""}</Text>
            </InlineStack>
            <Divider />
            <InlineStack align="space-between">
              <Text as="span" tone="subdued">Per submission</Text>
              <Badge tone="success">{rewardLabel}</Badge>
            </InlineStack>
            {hasMaxSubmissions && maxSubmissions && (
              <>
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Max submissions</Text>
                  <Text as="span">{maxSubmissions}</Text>
                </InlineStack>
                <Divider />
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">Max reward months</Text>
                  <Text as="span" fontWeight="bold">
                    {parseInt(maxSubmissions) * rewardMonths} months total
                  </Text>
                </InlineStack>
              </>
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

  const stepRenderers = [renderStepCampaign, renderStepReward, renderStepRights, renderStepReview];

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
