import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  ChoiceList,
  Button,
  Banner,
  Badge,
  Thumbnail,
  Box,
  Divider,
  List,
  Checkbox,
} from "@shopify/polaris";
import { USAGE_RIGHTS_INTRO, usageRightsClauses } from "../../utils/usage-rights";
import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { parseProducts, wallRewardOffer, type WallProduct } from "../../utils/wall-campaigns";
import { syncWallCampaignsNow } from "../../utils/canvas.server";
import { addToThemeUrl } from "../../utils/wall-theme.server";
import { PROXY_BASE } from "../../utils/proxy-path";
import { refreshWall } from "../../utils/public-media.server";
import { liveOnlineStoreProducts } from "../../utils/product-availability.server";
import { validateWall, type WallForm } from "../../utils/wall-validate";

import type { RewardChoice } from "../../utils/wall-validate";


const DEFAULTS: WallForm = {
  title: "",
  moment: "Show us how you use it — unboxing, first impressions, or your favourite way to use it.",
  checklist: [],
  contentType: "VIDEO",
  productScope: "SPECIFIC",
  products: [],
  rewardType: "NONE",
  discountCodeType: "PERCENTAGE",
  discountCodeAmount: "15",
  discountCodeMinOrder: "0",
  discountCodeExpiryDays: "0",
  storeCreditAmount: "10",
  storeCreditExpiryDays: "0",
  hasLimit: false,
  maxSubmissions: "50",
  rightsAccepted: false,
};

function checklistFrom(captureSpecs: string): string[] {
  try {
    const specs = JSON.parse(captureSpecs) as { label: string; description: string }[];
    return specs.filter((s) => s.label === "Requirement").map((s) => s.description);
  } catch {
    return [];
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true, brandName: true } });
  const brandName = shop?.brandName || session.shop.replace(".myshopify.com", "");
  const themeUrl = addToThemeUrl(session.shop, process.env.SHOPIFY_API_KEY || "");
  if (params.id === "new") {
    return json({ id: null as string | null, status: "DRAFT", form: DEFAULTS, themeUrl, shareUrl: null as string | null, posts: 0, activeSubmissions: 0, legacy: false, brandName });
  }
  const c = shop ? await prisma.campaign.findFirst({ where: { id: params.id, shopId: shop.id }, include: { _count: { select: { submissions: true } } } }) : null;
  if (!c) throw redirect("/app/walls");
  const form: WallForm = {
    title: c.title,
    moment: c.moment,
    checklist: checklistFrom(c.captureSpecs),
    contentType: c.contentType,
    productScope: c.productScope === "ALL" ? "ALL" : "SPECIFIC",
    products: parseProducts(c.products),
    rewardType: (["NONE", "DISCOUNT_CODE", "STORE_CREDIT"].includes(c.rewardType) ? c.rewardType : "NONE") as RewardChoice,
    discountCodeType: c.discountCodeType === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENTAGE",
    discountCodeAmount: c.discountCodeAmount != null ? String(c.discountCodeAmount) : DEFAULTS.discountCodeAmount,
    discountCodeMinOrder: c.discountCodeMinOrder != null ? String(c.discountCodeMinOrder) : "0",
    discountCodeExpiryDays: c.discountCodeExpiryDays != null ? String(c.discountCodeExpiryDays) : "0",
    storeCreditAmount: c.storeCreditAmount != null ? String(c.storeCreditAmount) : DEFAULTS.storeCreditAmount,
    storeCreditExpiryDays: c.storeCreditExpiryDays != null ? String(c.storeCreditExpiryDays) : "0",
    hasLimit: c.maxSubmissions != null,
    maxSubmissions: c.maxSubmissions != null ? String(c.maxSubmissions) : DEFAULTS.maxSubmissions,
    rightsAccepted: !!c.rightsAcknowledgedAt,
  };
  const activeSubmissions = await prisma.submission.count({ where: { campaignId: c.id, status: { not: "REJECTED" } } });
  return json({
    id: c.id as string | null,
    status: c.status,
    form,
    themeUrl,
    shareUrl: `https://${session.shop}${PROXY_BASE}/campaign/${c.id}/submit` as string | null,
    posts: c._count.submissions,
    activeSubmissions,
    legacy: c.rewardType === "SUBSCRIPTION_DISCOUNT",
    brandName,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  if (!shop) return json({ errors: ["Shop not found — reload the app."] }, { status: 400 });

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "save"); // save | activate | pause
  const existing = params.id !== "new" ? await prisma.campaign.findFirst({ where: { id: params.id, shopId: shop.id } }) : null;
  if (params.id !== "new" && !existing) return json({ errors: ["Wall campaign not found."] }, { status: 404 });

  if (intent === "pause" && existing) {
    await prisma.campaign.update({ where: { id: existing.id }, data: { status: "PAUSED" } });
    await syncWallCampaignsNow(admin.graphql, session.shop);
    await refreshWall(existing.id);
    return json({ ok: true, message: "Paused — the wall is now hidden on your store." });
  }

  let f: WallForm;
  try {
    f = { ...DEFAULTS, ...(JSON.parse(String(fd.get("data") || "{}")) as Partial<WallForm>) };
  } catch {
    return json({ errors: ["Couldn't read the form. Please try again."] }, { status: 400 });
  }
  const activating = intent === "activate";
  const errors = validateWall(f, activating || existing?.status === "ACTIVE");
  if (errors.length) return json({ errors }, { status: 400 });

  // Only products customers can open/buy on the Online Store
  if (f.productScope === "SPECIFIC" && f.products.length) {
    const live = await liveOnlineStoreProducts(admin.graphql, f.products.map((p) => p.id));
    const notLive = live ? f.products.filter((p) => !live.has(p.id)) : [];
    if (notLive.length) {
      return json(
        { errors: notLive.map((p) => `${p.title} isn't published to your Online Store. Publish it in Shopify or remove it from this wall campaign.`) },
        { status: 400 },
      );
    }
  }

  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
  /** Optional min/expiry fields: 0 (or blank) means "none" */
  const positiveOrNull = (v: string) => {
    const n = numOrNull(v);
    return n && n > 0 ? n : null;
  };
  const products = f.productScope === "ALL" ? [] : f.products.slice(0, 50);
  const data = {
    title: f.title.trim(),
    moment: f.moment.trim(),
    contentType: f.contentType,
    captureSpecs: JSON.stringify(f.checklist.map((d) => d.trim()).filter(Boolean).map((d) => ({ label: "Requirement", description: d }))),
    productScope: f.productScope,
    products: JSON.stringify(products),
    // legacy single-product columns (older code paths & reports)
    productId: products[0]?.id ?? null,
    productTitle: products[0]?.title ?? null,
    productImageUrl: products[0]?.imageUrl ?? null,
    rewardType: f.rewardType,
    discountCodeType: f.rewardType === "DISCOUNT_CODE" ? f.discountCodeType : null,
    discountCodeAmount: f.rewardType === "DISCOUNT_CODE" ? numOrNull(f.discountCodeAmount) : null,
    discountCodeMinOrder: f.rewardType === "DISCOUNT_CODE" ? positiveOrNull(f.discountCodeMinOrder) : null,
    discountCodeExpiryDays: f.rewardType === "DISCOUNT_CODE" ? positiveOrNull(f.discountCodeExpiryDays) : null,
    storeCreditAmount: f.rewardType === "STORE_CREDIT" ? numOrNull(f.storeCreditAmount) : null,
    storeCreditExpiryDays: f.rewardType === "STORE_CREDIT" ? positiveOrNull(f.storeCreditExpiryDays) : null,
    maxSubmissions: f.hasLimit ? numOrNull(f.maxSubmissions) : null,
    rightsAcknowledgedAt: f.rightsAccepted ? existing?.rightsAcknowledgedAt ?? new Date() : null,
    // subscription fields: neutral defaults (no longer offered)
    discountType: "FREE" as const,
    discountValue: 0,
    rewardCycles: 1,
    rewardFrequency: "MONTH" as const,
    ...(activating ? { status: "ACTIVE" as const } : {}),
  };

  const saved = existing
    ? await prisma.campaign.update({ where: { id: existing.id }, data })
    : await prisma.campaign.create({ data: { ...data, shopId: shop.id, status: activating ? "ACTIVE" : "DRAFT" } });

  const sync = await syncWallCampaignsNow(admin.graphql, session.shop);
  await refreshWall(saved.id);
  if (sync.errors.length) console.warn("[walls] sync after save had errors", sync.errors);

  if (!existing) return redirect(`/app/walls/${saved.id}?created=1`);
  return json({ ok: true, message: activating ? "Activated — the wall now shows on your store wherever its block is placed." : "Saved" });
};

const STEPS = ["Configure", "Usage rights", "Review"];

function StepNav({ step, onSelect, canJump }: { step: number; onSelect: (i: number) => void; canJump: (i: number) => boolean }) {
  return (
    <Card padding="300">
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {STEPS.map((label, i) => {
          const active = i === step;
          const done = i < step;
          return (
            <InlineStack key={label} gap="200" blockAlign="center" wrap={false}>
              {i > 0 && <div style={{ width: 24, height: 1, background: "var(--p-color-border)" }} />}
              <button
                type="button"
                onClick={() => canJump(i) && onSelect(i)}
                disabled={!canJump(i)}
                style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, padding: "4px 6px", cursor: canJump(i) ? "pointer" : "default", font: "inherit" }}
              >
                <span
                  style={{
                    width: 24, height: 24, borderRadius: 999, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 650,
                    background: active ? "var(--p-color-bg-fill-brand)" : done ? "var(--p-color-bg-fill-success)" : "var(--p-color-bg-fill-secondary)",
                    color: active || done ? "#fff" : "var(--p-color-text-secondary)",
                  }}
                >
                  {done ? "✓" : i + 1}
                </span>
                <Text as="span" variant="bodyMd" fontWeight={active ? "semibold" : "regular"} tone={active ? undefined : "subdued"}>
                  {label}
                </Text>
              </button>
            </InlineStack>
          );
        })}
      </InlineStack>
    </Card>
  );
}

function ReviewRow({ label, onEdit, children }: { label: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h3" variant="headingSm">{label}</Text>
        <Button variant="plain" onClick={onEdit}>Edit</Button>
      </InlineStack>
      <div>{children}</div>
      <Divider />
    </BlockStack>
  );
}

export default function WallCampaignEditor() {
  const { id, status, form: initial, themeUrl, shareUrl, posts, activeSubmissions, legacy, brandName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { errors?: string[]; ok?: boolean; message?: string } | undefined;
  const nav = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const [params] = useSearchParams();
  const [f, setF] = useState<WallForm>(initial as WallForm);
  const [newItem, setNewItem] = useState("");
  const [step, setStep] = useState(params.get("created") ? 2 : 0);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const busy = nav.state !== "idle";
  const busyIntent = nav.formData?.get("intent");

  useEffect(() => setF(initial as WallForm), [initial]);
  useEffect(() => {
    if (actionData?.ok && actionData.message) shopify.toast.show(actionData.message);
  }, [actionData, shopify]);

  const set = useCallback(<K extends keyof WallForm>(k: K, v: WallForm[K]) => setF((p) => ({ ...p, [k]: v })), []);
  const dirty = useMemo(() => JSON.stringify(f) !== JSON.stringify(initial), [f, initial]);

  const send = (intent: "save" | "activate" | "pause") => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("data", JSON.stringify(f));
    submit(fd, { method: "post" });
  };

  const pickProducts = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        selectionIds: f.products.map((p) => ({ id: p.id })),
        // Only products customers can buy: no drafts/archived, published to the Online Store
        filter: { variants: false, draft: false, archived: false, query: "published_status:published" },
      });
      if (selected) {
        let picked: WallProduct[] = selected.map((p: any) => ({
          id: p.id,
          title: p.title,
          handle: p.handle ?? null,
          imageUrl: p.images?.[0]?.originalSrc ?? p.images?.[0]?.url ?? null,
        }));
        // Double-check with Shopify — the picker filter isn't guaranteed
        const res = await fetch("/app/api/products-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: picked.map((p) => p.id) }),
        }).then((r) => r.json()).catch(() => ({ live: null }));
        if (Array.isArray(res.live)) {
          const live = new Set<string>(res.live);
          const dropped = picked.filter((p) => !live.has(p.id));
          picked = picked.filter((p) => live.has(p.id));
          if (dropped.length) {
            shopify.toast.show(
              dropped.length === 1
                ? `${dropped[0].title} isn't on your Online Store, so it wasn't added`
                : `${dropped.length} products aren't on your Online Store, so they weren't added`,
              { isError: true, duration: 6000 },
            );
          }
        }
        set("products", picked);
      }
    } catch {
      /* picker closed */
    }
  };

  const offer = wallRewardOffer({
    rewardType: f.rewardType,
    discountCodeType: f.discountCodeType,
    discountCodeAmount: Number(f.discountCodeAmount || 0),
    storeCreditAmount: Number(f.storeCreditAmount || 0),
  });
  const statusBadge = status === "ACTIVE" ? <Badge tone="success">Active</Badge> : status === "PAUSED" ? <Badge tone="attention">Paused</Badge> : <Badge tone="info">Draft</Badge>;
  const isNew = !id;

  const step0Errors = () => validateWall({ ...f, rightsAccepted: true }, true);
  const goTo = (target: number) => {
    if (target > step && step === 0) {
      const errs = step0Errors();
      if (errs.length) return setClientErrors(errs);
    }
    if (target > 1 && !f.rightsAccepted) {
      setStep(1);
      return setClientErrors(["Accept the usage rights agreement to continue."]);
    }
    setClientErrors([]);
    setStep(target);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };

  const draftAction = { content: isNew ? "Save as draft" : "Save draft", onAction: () => send("save"), loading: busy && busyIntent === "save", disabled: busy || (!isNew && !dirty) };
  const backAction = { content: "Back", onAction: () => goTo(step - 1), disabled: busy };
  const pauseAction = { content: "Pause", onAction: () => send("pause"), loading: busy && busyIntent === "pause", disabled: busy, destructive: true };
  const saveLive = { content: "Save changes", onAction: () => send("save"), loading: busy && busyIntent === "save", disabled: busy || !dirty };

  const primary =
    step === 0
      ? { content: "Next: Usage rights", onAction: () => goTo(1), disabled: busy }
      : step === 1
        ? { content: "Next: Review", onAction: () => goTo(2), disabled: busy || !f.rightsAccepted }
        : isNew
          ? { content: "Create and activate", onAction: () => send("activate"), loading: busy && busyIntent === "activate", disabled: busy }
          : status === "ACTIVE"
            ? saveLive
            : { content: "Activate", onAction: () => send("activate"), loading: busy && busyIntent === "activate", disabled: busy };
  const secondary = [
    ...(step > 0 ? [backAction] : []),
    ...(status === "ACTIVE" && !isNew ? (step < 2 ? [saveLive] : []) : [draftAction]),
    ...(status === "ACTIVE" && !isNew ? [pauseAction] : []),
  ];

  return (
    <Page
      title={isNew ? "New wall campaign" : f.title || "Wall campaign"}
      titleMetadata={isNew ? undefined : statusBadge}
      backAction={{ content: "Wall campaigns", url: "/app/walls" }}
      primaryAction={primary}
      secondaryActions={secondary}
    >
      <Layout>
        {legacy && (
          <Layout.Section>
            <Banner tone="warning" title="Subscription rewards are no longer offered">
              This wall campaign used a subscription discount. Choose a new reward below before activating it again.
            </Banner>
          </Layout.Section>
        )}
        {params.get("created") && (
          <Layout.Section>
            <Banner tone="success" title={status === "ACTIVE" ? "Your wall campaign is active" : "Wall campaign saved as a draft"}>
              <BlockStack gap="200">
                <Text as="p">Next, show it on your store:</Text>
                <List type="number">
                  <List.Item>Open the theme editor and add the <b>Social Wall</b> block.</List.Item>
                  <List.Item>In the block settings, choose <b>{f.title}</b> under “Wall campaign”, then save.</List.Item>
                  {status !== "ACTIVE" && <List.Item>Come back here and click <b>Activate</b>.</List.Item>}
                </List>
                <InlineStack>
                  <Button url={themeUrl} target="_top" variant="primary">Add to theme</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}
        {actionData?.errors?.length ? (
          <Layout.Section>
            <Banner tone="critical" title="Please fix the following">
              <List>
                {actionData.errors.map((e) => (
                  <List.Item key={e}>{e}</List.Item>
                ))}
              </List>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            <StepNav step={step} onSelect={goTo} canJump={(i) => i <= step || !isNew} />
            {clientErrors.length > 0 && (
              <Banner tone="critical" title="Please fix the following" onDismiss={() => setClientErrors([])}>
                <List>
                  {clientErrors.map((e) => (
                    <List.Item key={e}>{e}</List.Item>
                  ))}
                </List>
              </Banner>
            )}
            {step === 0 && (
              <>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Name</Text>
                <TextField
                  label="Wall campaign name"
                  labelHidden
                  value={f.title}
                  onChange={(v) => set("title", v)}
                  autoComplete="off"
                  placeholder="e.g. Homepage wall"
                  helpText="Only you see this — it's how you pick the wall in the theme editor."
                  maxLength={80}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Products</Text>
                <Text as="p" tone="subdued">Only customers who bought these can submit. Their videos link to the product they bought. Only products published to your Online Store can be picked.</Text>
                <ChoiceList
                  title="Products"
                  titleHidden
                  choices={[
                    { label: "Specific products", value: "SPECIFIC" },
                    { label: "All products", value: "ALL", helpText: "Anyone who has ordered from your store can share." },
                  ]}
                  selected={[f.productScope]}
                  onChange={(v) => set("productScope", v[0] as WallForm["productScope"])}
                />
                {f.productScope === "SPECIFIC" && (
                  <BlockStack gap="200">
                    {f.products.map((p) => (
                      <InlineStack key={p.id} align="space-between" blockAlign="center" wrap={false}>
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <Thumbnail source={p.imageUrl || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_small.png"} alt="" size="small" />
                          <Text as="span">{p.title}</Text>
                        </InlineStack>
                        <Button variant="plain" tone="critical" onClick={() => set("products", f.products.filter((x) => x.id !== p.id))}>
                          Remove
                        </Button>
                      </InlineStack>
                    ))}
                    <InlineStack>
                      <Button onClick={pickProducts}>{f.products.length ? "Change products" : "Select products"}</Button>
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">What to ask for</Text>
                <Select
                  label="Content"
                  options={[
                    { label: "Videos", value: "VIDEO" },
                    { label: "Photos", value: "PHOTO" },
                  ]}
                  value={f.contentType}
                  onChange={(v) => set("contentType", v as WallForm["contentType"])}
                />
                <TextField
                  label="Your ask"
                  value={f.moment}
                  onChange={(v) => set("moment", v)}
                  multiline={3}
                  autoComplete="off"
                  helpText="Shown to customers when they share, e.g. “Show us your morning routine with it.”"
                  maxLength={500}
                  showCharacterCount
                />
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="medium">Checklist (optional)</Text>
                  {f.checklist.map((item, i) => (
                    <InlineStack key={`${i}-${item}`} align="space-between" blockAlign="center" wrap={false}>
                      <Text as="span">• {item}</Text>
                      <Button variant="plain" tone="critical" onClick={() => set("checklist", f.checklist.filter((_, j) => j !== i))}>
                        Remove
                      </Button>
                    </InlineStack>
                  ))}
                  <InlineStack gap="200" blockAlign="end" wrap={false}>
                    <Box width="100%">
                      <TextField
                        label="Add a checklist item"
                        labelHidden
                        placeholder="e.g. Show the product in natural light"
                        value={newItem}
                        onChange={setNewItem}
                        autoComplete="off"
                        maxLength={140}
                      />
                    </Box>
                    <Button
                      disabled={!newItem.trim()}
                      onClick={() => {
                        set("checklist", [...f.checklist, newItem.trim()].slice(0, 10));
                        setNewItem("");
                      }}
                    >
                      Add
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Reward</Text>
                <ChoiceList
                  title="Reward"
                  titleHidden
                  choices={[
                    { label: "No reward — being featured is the reward", value: "NONE" },
                    { label: "Discount code", value: "DISCOUNT_CODE", helpText: "A single-use code, only for that customer." },
                    { label: "Store credit", value: "STORE_CREDIT", helpText: "Added to the customer's account — they use it at checkout." },
                  ]}
                  selected={[f.rewardType]}
                  onChange={(v) => set("rewardType", v[0] as RewardChoice)}
                />
                {f.rewardType === "DISCOUNT_CODE" && (
                  <BlockStack gap="300">
                    <InlineStack gap="300" wrap={false}>
                      <Box width="50%">
                        <Select
                          label="Type"
                          options={[
                            { label: "Percentage off", value: "PERCENTAGE" },
                            { label: "Fixed amount off", value: "FIXED_AMOUNT" },
                          ]}
                          value={f.discountCodeType}
                          onChange={(v) => set("discountCodeType", v as WallForm["discountCodeType"])}
                        />
                      </Box>
                      <Box width="50%">
                        <TextField
                          label="Amount"
                          type="number"
                          value={f.discountCodeAmount}
                          onChange={(v) => set("discountCodeAmount", v)}
                          suffix={f.discountCodeType === "PERCENTAGE" ? "%" : undefined}
                          prefix={f.discountCodeType === "FIXED_AMOUNT" ? "$" : undefined}
                          autoComplete="off"
                          min={0}
                        />
                      </Box>
                    </InlineStack>
                    <InlineStack gap="300" wrap={false}>
                      <Box width="50%">
                        <TextField label="Minimum order" type="number" prefix="$" value={f.discountCodeMinOrder} onChange={(v) => set("discountCodeMinOrder", v)} autoComplete="off" min={0} helpText="Leave at 0 for no minimum order" />
                      </Box>
                      <Box width="50%">
                        <TextField label="Expires after" type="number" suffix="days" value={f.discountCodeExpiryDays} onChange={(v) => set("discountCodeExpiryDays", v)} autoComplete="off" min={0} helpText="Leave at 0 for no expiry" />
                      </Box>
                    </InlineStack>
                  </BlockStack>
                )}
                {f.rewardType === "STORE_CREDIT" && (
                  <InlineStack gap="300" wrap={false}>
                    <Box width="50%">
                      <TextField label="Amount" type="number" prefix="$" value={f.storeCreditAmount} onChange={(v) => set("storeCreditAmount", v)} autoComplete="off" min={0} />
                    </Box>
                    <Box width="50%">
                      <TextField label="Expires after" type="number" suffix="days" value={f.storeCreditExpiryDays} onChange={(v) => set("storeCreditExpiryDays", v)} autoComplete="off" min={0} helpText="Leave at 0 for no expiry" />
                    </Box>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Limits (optional)</Text>
                <Checkbox
                  label="Limit how many customers can share"
                  helpText="Customers see how many spots are left. Sharing closes when the wall is full (rejected submissions free up a spot)."
                  checked={f.hasLimit}
                  onChange={(v) => set("hasLimit", v)}
                />
                {f.hasLimit && (
                  <Box maxWidth="240px">
                    <TextField
                      label="Maximum submissions"
                      type="number"
                      value={f.maxSubmissions}
                      onChange={(v) => set("maxSubmissions", v)}
                      min={1}
                      autoComplete="off"
                      helpText={id ? `${activeSubmissions} used so far` : undefined}
                    />
                  </Box>
                )}
              </BlockStack>
            </Card>

              </>
            )}
            {step === 1 && (
              <>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Content usage rights</Text>
                <Text as="p" tone="subdued">
                  Customers must agree to these terms before they share, so you can use their content across your marketing.
                </Text>
                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="p" fontWeight="semibold">{USAGE_RIGHTS_INTRO}</Text>
                    {usageRightsClauses(brandName).map((c, i) => (
                      <Text as="p" key={i}>{`${i + 1}. ${c}`}</Text>
                    ))}
                  </BlockStack>
                </Box>
                <Checkbox
                  label="I have reviewed and accept these usage rights for this wall campaign"
                  checked={f.rightsAccepted}
                  onChange={(v) => set("rightsAccepted", v)}
                />
              </BlockStack>
            </Card>
              </>
            )}
            {step < 2 && (
              <InlineStack align="end" gap="200">
                {step > 0 && <Button onClick={() => goTo(step - 1)} disabled={busy}>Back</Button>}
                <Button variant="primary" onClick={() => goTo(step + 1)} disabled={busy || (step === 1 && !f.rightsAccepted)}>
                  {step === 0 ? "Next: Usage rights" : "Next: Review"}
                </Button>
              </InlineStack>
            )}
            {step === 2 && (
              <>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Review</Text>
                <ReviewRow label="Name" onEdit={() => goTo(0)}>{f.title || "—"}</ReviewRow>
                <ReviewRow label="Who can share" onEdit={() => goTo(0)}>
                  {f.productScope === "ALL"
                    ? "Anyone who has ordered from your store"
                    : f.products.length
                      ? `Verified buyers of ${f.products.map((p) => p.title).join(", ")}`
                      : "No products selected"}
                </ReviewRow>
                <ReviewRow label="Asking for" onEdit={() => goTo(0)}>
                  <BlockStack gap="100">
                    <Text as="p">{f.contentType === "VIDEO" ? "Videos" : "Photos"}: {f.moment || "—"}</Text>
                    {f.checklist.map((c, i) => (
                      <Text as="p" key={i} tone="subdued" variant="bodySm">• {c}</Text>
                    ))}
                  </BlockStack>
                </ReviewRow>
                <ReviewRow label="Reward" onEdit={() => goTo(0)}>
                  <BlockStack gap="100">
                    <Text as="p">{offer}</Text>
                    {f.rewardType === "DISCOUNT_CODE" && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        {Number(f.discountCodeMinOrder) > 0 ? `Minimum order $${f.discountCodeMinOrder}` : "No minimum order"}
                        {" · "}
                        {Number(f.discountCodeExpiryDays) > 0 ? `expires after ${f.discountCodeExpiryDays} days` : "no expiry"}
                      </Text>
                    )}
                    {f.rewardType === "STORE_CREDIT" && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        {Number(f.storeCreditExpiryDays) > 0 ? `Expires after ${f.storeCreditExpiryDays} days` : "No expiry"}
                      </Text>
                    )}
                  </BlockStack>
                </ReviewRow>
                <ReviewRow label="Limit" onEdit={() => goTo(0)}>
                  {f.hasLimit ? `Up to ${f.maxSubmissions} submissions` : "No limit"}
                </ReviewRow>
                <ReviewRow label="Usage rights" onEdit={() => goTo(1)}>
                  {f.rightsAccepted ? <Badge tone="success">Accepted</Badge> : <Badge tone="critical">Not accepted</Badge>}
                </ReviewRow>
              </BlockStack>
            </Card>
              </>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {step === 1 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Why this matters</Text>
                  <Divider />
                  <Text as="p" variant="bodySm">
                    Clear usage rights protect both you and your customers. Without them, you may not be able to use submitted content in ads or on social media.
                  </Text>
                  <Text as="p" variant="bodySm">
                    Customers see the same terms and must agree to them before they share.
                  </Text>
                </BlockStack>
              </Card>
            )}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Customers see</Text>
                <Badge tone="success">{offer}</Badge>
                <Text as="p" tone="subdued" variant="bodySm">
                  {f.productScope === "ALL"
                    ? "For anyone who has ordered from your store."
                    : f.products.length
                      ? `For verified buyers of ${f.products.map((p) => p.title).join(", ")}.`
                      : "Pick products to choose who can share."}
                </Text>
                <Divider />
                <Text as="p" variant="bodySm" tone="subdued">Every approved submission shows a “Verified buyer” badge on the wall. Customers can choose to show their first name.</Text>
              </BlockStack>
            </Card>
            {!isNew && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">On your store</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {status === "ACTIVE"
                      ? "Live wherever its Social Wall block is placed."
                      : "Hidden — activate it to show the wall."}
                  </Text>
                  <Text as="p" variant="bodySm">{posts} submission{posts === 1 ? "" : "s"} so far</Text>
                  <InlineStack gap="200">
                    <Button url={themeUrl} target="_top">Add to theme</Button>
                    {shareUrl && (
                      <Button url={shareUrl} target="_blank" variant="plain">Preview share page</Button>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">In the theme editor, choose “{f.title || "this wall campaign"}” in the block's Wall campaign setting.</Text>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
