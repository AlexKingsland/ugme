import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
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
  Divider,
  Banner,
  RangeSlider,
  Checkbox,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
  });

  if (!campaign) {
    throw new Response("Campaign not found", { status: 404 });
  }

  let captureSpecs: Array<{ label: string; description: string }> = [];
  try {
    captureSpecs = JSON.parse(campaign.captureSpecs);
  } catch {
    captureSpecs = [];
  }

  return json({
    campaign: {
      id: campaign.id,
      title: campaign.title,
      moment: campaign.moment,
      contentType: campaign.contentType,
      rewardMonths: campaign.rewardMonths,
      maxSubmissions: campaign.maxSubmissions,
      startDate: campaign.startDate
        ? new Date(campaign.startDate).toISOString().split("T")[0]
        : null,
      endDate: campaign.endDate
        ? new Date(campaign.endDate).toISOString().split("T")[0]
        : null,
      captureSpecs,
      status: campaign.status,
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const { id } = params;
  const formData = await request.formData();

  const title = formData.get("title") as string;
  const moment = formData.get("moment") as string;
  const contentType = formData.get("contentType") as string;
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

  // Validation
  const errors: string[] = [];
  if (!title || title.trim().length === 0) errors.push("Title is required.");
  if (!moment || moment.trim().length === 0) errors.push("Creative moment is required.");
  if (rewardMonths < 1 || rewardMonths > 12) errors.push("Reward months must be between 1 and 12.");
  if (startDate && endDate && endDate <= startDate) errors.push("End date must be after start date.");

  if (errors.length > 0) {
    return json({ error: errors.join(" ") }, { status: 400 });
  }

  let captureSpecs = "[]";
  try {
    if (captureSpecsRaw) {
      const parsed = JSON.parse(captureSpecsRaw);
      captureSpecs = JSON.stringify(parsed);
    }
  } catch {
    captureSpecs = "[]";
  }

  await prisma.campaign.update({
    where: { id },
    data: {
      title: title.trim(),
      moment: moment.trim(),
      contentType: contentType === "VIDEO" ? "VIDEO" : "PHOTO",
      rewardMonths,
      maxSubmissions,
      startDate,
      endDate,
      captureSpecs,
    },
  });

  return redirect(`/app/campaigns/${id}`);
};

export default function EditCampaignPage() {
  const { campaign } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const actionData = useActionData<typeof action>();
  const isSubmitting = navigation.state === "submitting";

  // Form state — pre-filled from existing campaign
  const [title, setTitle] = useState(campaign.title);
  const [moment, setMoment] = useState(campaign.moment);
  const [contentType, setContentType] = useState(campaign.contentType);
  const [rewardMonths, setRewardMonths] = useState(campaign.rewardMonths);
  const [maxSubmissions, setMaxSubmissions] = useState(
    campaign.maxSubmissions?.toString() ?? "",
  );
  const [startDate, setStartDate] = useState(campaign.startDate ?? "");
  const [endDate, setEndDate] = useState(campaign.endDate ?? "");
  const [hasDateRange, setHasDateRange] = useState(
    !!(campaign.startDate || campaign.endDate),
  );
  const [hasMaxSubmissions, setHasMaxSubmissions] = useState(
    campaign.maxSubmissions !== null,
  );

  // Capture specs
  const [specs, setSpecs] = useState<Array<{ label: string; description: string }>>(
    campaign.captureSpecs,
  );
  const [newSpecLabel, setNewSpecLabel] = useState("");
  const [newSpecDescription, setNewSpecDescription] = useState("");

  const addSpec = useCallback(() => {
    if (newSpecLabel.trim()) {
      setSpecs((prev) => [...prev, { label: newSpecLabel.trim(), description: newSpecDescription.trim() }]);
      setNewSpecLabel("");
      setNewSpecDescription("");
    }
  }, [newSpecLabel, newSpecDescription]);

  const removeSpec = useCallback((index: number) => {
    setSpecs((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    const formData = new FormData();
    formData.set("title", title);
    formData.set("moment", moment);
    formData.set("contentType", contentType);
    formData.set("rewardMonths", String(rewardMonths));
    if (hasMaxSubmissions && maxSubmissions) {
      formData.set("maxSubmissions", maxSubmissions);
    }
    if (hasDateRange) {
      if (startDate) formData.set("startDate", startDate);
      if (endDate) formData.set("endDate", endDate);
    }
    if (specs.length > 0) {
      formData.set("captureSpecs", JSON.stringify(specs));
    }
    submit(formData, { method: "post" });
  }, [title, moment, contentType, rewardMonths, maxSubmissions, startDate, endDate, hasDateRange, hasMaxSubmissions, specs, submit]);

  return (
    <Page
      backAction={{ content: "Campaign", url: `/app/campaigns/${campaign.id}` }}
      title={`Edit: ${campaign.title}`}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error && (
              <Banner tone="critical">{actionData.error}</Banner>
            )}

            {/* Basic info */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Campaign details</Text>
                <FormLayout>
                  <TextField
                    label="Campaign title"
                    value={title}
                    onChange={setTitle}
                    autoComplete="off"
                  />
                  <TextField
                    label="Creative moment"
                    value={moment}
                    onChange={setMoment}
                    multiline={3}
                    autoComplete="off"
                  />
                  <Select
                    label="Content type"
                    options={[
                      { label: "Video", value: "VIDEO" },
                      { label: "Photo", value: "PHOTO" },
                    ]}
                    value={contentType}
                    onChange={setContentType}
                  />
                </FormLayout>
              </BlockStack>
            </Card>

            {/* Capture specs */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Capture specs</Text>
                <Text as="p" tone="subdued">
                  Guidelines for content quality — orientation, lighting, duration, etc.
                </Text>

                {specs.length > 0 && (
                  <BlockStack gap="200">
                    {specs.map((spec, i) => (
                      <InlineStack key={i} align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="span" fontWeight="semibold">{spec.label}</Text>
                          {spec.description && (
                            <Text as="span" tone="subdued">{spec.description}</Text>
                          )}
                        </BlockStack>
                        <Button variant="plain" tone="critical" onClick={() => removeSpec(i)}>
                          Remove
                        </Button>
                      </InlineStack>
                    ))}
                    <Divider />
                  </BlockStack>
                )}

                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Spec name"
                      value={newSpecLabel}
                      onChange={setNewSpecLabel}
                      placeholder="e.g. Orientation"
                      autoComplete="off"
                    />
                    <TextField
                      label="Description"
                      value={newSpecDescription}
                      onChange={setNewSpecDescription}
                      placeholder="e.g. Landscape preferred, minimum 720p"
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                </FormLayout>
                <InlineStack>
                  <Button onClick={addSpec} disabled={!newSpecLabel.trim()}>
                    Add spec
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Reward */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Reward</Text>
                <RangeSlider
                  label={`${rewardMonths} month${rewardMonths !== 1 ? "s" : ""} free`}
                  value={rewardMonths}
                  min={1}
                  max={6}
                  step={1}
                  onChange={(value) => setRewardMonths(value as number)}
                  output
                />
                <Text as="p" tone="subdued">
                  Months free on the customer's subscription when their content is approved.
                </Text>
              </BlockStack>
            </Card>

            {/* Limits */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Limits</Text>

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

            {/* Save */}
            <Card>
              <BlockStack gap="300">
                <Button
                  variant="primary"
                  size="large"
                  fullWidth
                  onClick={handleSubmit}
                  loading={isSubmitting}
                >
                  Save changes
                </Button>
                <Button
                  fullWidth
                  url={`/app/campaigns/${campaign.id}`}
                >
                  Cancel
                </Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
