/**
 * "Add your own posts": the merchant uploads their own photos/videos to a wall so a
 * new wall isn't empty. Files go straight from the browser to storage (presigned
 * PUT), like customer uploads; then the post is created as approved.
 */
import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Button, Banner, TextField, Checkbox, Badge, ProgressBar, Box } from "@shopify/polaris";
import { useCallback, useRef, useState } from "react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { parseProducts, contentWord } from "../../utils/wall-campaigns";
import { checkStorageLimit, checkSubmissionLimit, getPlan, type PlanTierKey } from "../../utils/plans.server";
import { completeBrandUpload, createBrandUpload, BRAND_MAX_BYTES } from "../../utils/brand-posts.server";
import { mediaUrlsFor } from "../../utils/submission-media.server";
import { extractKeyFromContentUrl, getPresignedDownloadUrl } from "../../utils/r2.server";
import { formatBytes } from "../../utils/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true, planTier: true } });
  if (!shop) return redirect("/app");
  const c = await prisma.campaign.findFirst({ where: { id: params.id, shopId: shop.id }, select: { id: true, title: true, status: true, contentType: true, productScope: true, products: true } });
  if (!c) return redirect("/app/walls");
  const tier = (shop.planTier as PlanTierKey) || "FREE";
  const [approvals, storage, posts] = await Promise.all([
    checkSubmissionLimit(shop.id, tier),
    checkStorageLimit(shop.id, tier),
    prisma.submission.findMany({
      where: { campaignId: c.id, fromBrand: true, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, contentType: true, contentUrl: true, thumbnailUrl: true, description: true, createdAt: true, status: true },
    }),
  ]);
  return json({
    wall: {
      id: c.id,
      title: c.title,
      active: c.status === "ACTIVE",
      contentType: c.contentType,
      word: contentWord(c.contentType, true),
      products: c.productScope === "ALL" ? [] : parseProducts(c.products),
    },
    approvals: { used: approvals.used, limit: Number.isFinite(approvals.limit) ? approvals.limit : null, ok: approvals.ok, period: approvals.period },
    storage: { usedLabel: formatBytes(storage.usedBytes), limitLabel: getPlan(tier).storageLabel },
    maxBytes: BRAND_MAX_BYTES,
    posts: await Promise.all(
      posts.map(async (p) => {
        const key = p.thumbnailUrl ? extractKeyFromContentUrl(p.thumbnailUrl) : null;
        const thumb = key ? await getPresignedDownloadUrl(key, 15 * 60).catch(() => null) : p.contentType === "PHOTO" ? (await mediaUrlsFor(p)).viewUrl : null;
        return { id: p.id, contentType: p.contentType, thumb, caption: p.description };
      }),
    ),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true, shopDomain: true, planTier: true } });
  if (!shop) return json({ ok: false, error: "not_found" }, { status: 404 });
  const body = await request.json();
  if (body.intent === "upload-url") {
    return json(await createBrandUpload(shop, params.id!, { name: String(body.name || "upload"), type: String(body.type || ""), size: Number(body.size || 0) }));
  }
  if (body.intent === "complete") {
    return json(
      await completeBrandUpload(shop, params.id!, {
        key: String(body.key || ""),
        expires: Number(body.expires || 0),
        token: String(body.token || ""),
        caption: String(body.caption || ""),
        productIds: Array.isArray(body.productIds) ? body.productIds.map(String) : [],
        hasPoster: !!body.hasPoster,
        durationSecs: Number(body.durationSecs || 0),
      }),
    );
  }
  return json({ ok: false, error: "unknown" }, { status: 400 });
};

const ERRORS: Record<string, string> = {
  too_large: "That file is too big (max 1 GB).",
  wrong_type: "This wall doesn't take that kind of file.",
  storage: "You're out of storage. Upgrade your plan or delete posts you don't need.",
  approvals: "You've used all the posts your plan includes. Upgrade, or delete posts you no longer need.",
  not_found: "This wall campaign doesn't exist any more.",
  upload_failed: "The upload didn't go through. Please try again.",
  expired: "The upload took too long. Please try again.",
  convert: "We couldn't open this photo (HEIC). Please choose a JPEG or PNG.",
};

// ── browser helpers ───────────────────────────────────────────────
const HEIC_TO = "https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/iife/heic-to.js";
const isHeic = (f: File) => (f.type || "").toLowerCase().startsWith("image/hei") || /[.]hei[cf]$/i.test(f.name);

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if ((window as any).HeicTo) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("converter failed to load"));
    document.head.appendChild(el);
  });
}

async function toJpegIfHeic(file: File): Promise<File> {
  if (!isHeic(file)) return file;
  let blob: Blob | null = null;
  try {
    const bmp = await createImageBitmap(file);
    blob = await drawToJpeg(bmp, bmp.width, bmp.height, 4096);
  } catch {
    await loadScript(HEIC_TO);
    const h = (window as any).HeicTo;
    blob = await (h.heicTo || h)({ blob: file, type: "image/jpeg", quality: 0.9 });
  }
  return new File([blob!], file.name.replace(/[.]hei[cf]$/i, "") + ".jpg", { type: "image/jpeg" });
}

function drawToJpeg(src: CanvasImageSource, w: number, h: number, max: number): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w * scale));
  c.height = Math.max(2, Math.round(h * scale));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
}

/** Small JPEG poster (and duration for videos) made from the local file. */
async function makePoster(file: File): Promise<{ poster: Blob | null; durationSecs: number }> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { poster: await drawToJpeg(img, img.naturalWidth, img.naturalHeight, 800), durationSecs: 0 };
    }
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error("video"));
      setTimeout(() => rej(new Error("timeout")), 15000);
    });
    v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 3000);
    });
    return { poster: await drawToJpeg(v, v.videoWidth || 720, v.videoHeight || 1280, 800), durationSecs: v.duration || 0 };
  } catch {
    return { poster: null, durationSecs: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function put(url: string, body: Blob, type: string, onProgress?: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(body);
  });
}

type Job = { name: string; pct: number; state: "waiting" | "uploading" | "done" | "error"; error?: string };

export default function BrandPosts() {
  const { wall, approvals, storage, posts } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const inputRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [productIds, setProductIds] = useState<string[]>(wall.products.length === 1 ? [wall.products[0].id] : []);
  const [jobs, setJobs] = useState<Job[]>([]);
  const busy = jobs.some((j) => j.state === "uploading" || j.state === "waiting");
  const accept = wall.contentType === "VIDEO" ? "video/*" : wall.contentType === "PHOTO" ? "image/*,.heic,.heif" : "video/*,image/*,.heic,.heif";

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch(`/app/walls/${wall.id}/posts?_data=brand-posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  }, [wall.id]);

  const upload = useCallback(async (files: File[]) => {
    setJobs(files.map((f) => ({ name: f.name, pct: 0, state: "waiting" })));
    const update = (i: number, patch: Partial<Job>) => setJobs((js) => js.map((j, k) => (k === i ? { ...j, ...patch } : j)));
    for (let i = 0; i < files.length; i++) {
      update(i, { state: "uploading" });
      try {
        let file: File;
        try {
          file = await toJpegIfHeic(files[i]);
        } catch {
          throw new Error("convert");
        }
        const start = await post({ intent: "upload-url", name: file.name, type: file.type, size: file.size });
        if (!start.ok) throw new Error(start.error || "upload_failed");
        const { poster, durationSecs } = await makePoster(file);
        await put(start.uploadUrl, file, file.type || "application/octet-stream", (pct) => update(i, { pct }));
        let hasPoster = false;
        if (poster) hasPoster = await put(start.posterUploadUrl, poster, "image/jpeg").then(() => true, () => false);
        const done = await post({ intent: "complete", key: start.key, expires: start.expires, token: start.token, caption, productIds, hasPoster, durationSecs });
        if (!done.ok) throw new Error(done.error || "upload_failed");
        update(i, { state: "done", pct: 100 });
      } catch (e) {
        const code = e instanceof Error ? e.message : "upload_failed";
        update(i, { state: "error", error: ERRORS[code] || ERRORS.upload_failed });
      }
    }
    setCaption("");
    revalidator.revalidate();
  }, [caption, productIds, post, revalidator]);

  return (
    <Page backAction={{ content: wall.title, url: `/app/walls/${wall.id}` }} title="Add your own posts" subtitle={wall.title}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="p">
                  Fill a new wall with your own {wall.word}. They go live straight away with a <b>From the brand</b> label, so
                  shoppers can tell them apart from verified buyers' posts.
                </Text>
                {!approvals.ok && (
                  <Banner tone="warning" action={{ content: "Upgrade plan", url: "/app/settings/billing" }}>
                    You've used all the posts your plan includes. Upgrade, or delete posts you no longer need, to add more.
                  </Banner>
                )}
                <TextField label="Caption (optional)" value={caption} onChange={setCaption} maxLength={300} showCharacterCount autoComplete="off" helpText="Shown with each post you add now." />
                {wall.products.length > 0 && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd" fontWeight="medium">Link products (optional)</Text>
                    {wall.products.map((p) => (
                      <Checkbox
                        key={p.id}
                        label={p.title}
                        checked={productIds.includes(p.id)}
                        onChange={(on) => setProductIds((ids) => (on ? [...ids, p.id] : ids.filter((x) => x !== p.id)))}
                      />
                    ))}
                  </BlockStack>
                )}
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={accept}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = "";
                    if (files.length) void upload(files);
                  }}
                />
                <InlineStack gap="300" blockAlign="center">
                  <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={busy || !approvals.ok} loading={busy}>
                    {`Choose ${wall.word}`}
                  </Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {approvals.limit == null ? "Unlimited posts" : `${approvals.used} of ${approvals.limit} posts used${approvals.period === "month" ? " this month" : ""}`} · {storage.usedLabel} of {storage.limitLabel}
                  </Text>
                </InlineStack>
                {jobs.length > 0 && (
                  <BlockStack gap="200">
                    {jobs.map((j, i) => (
                      <BlockStack key={i} gap="100">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" variant="bodySm" truncate>{j.name}</Text>
                          {j.state === "done" ? <Badge tone="success">Added</Badge> : j.state === "error" ? <Badge tone="critical">Failed</Badge> : <Text as="span" variant="bodySm" tone="subdued">{j.state === "waiting" ? "Waiting" : `${j.pct}%`}</Text>}
                        </InlineStack>
                        {j.state === "uploading" && <ProgressBar progress={j.pct} size="small" />}
                        {j.error && <Text as="p" variant="bodySm" tone="critical">{j.error}</Text>}
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{`Your posts on this wall (${posts.length})`}</Text>
                {posts.length === 0 ? (
                  <Text as="p" tone="subdued">None yet.</Text>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 12 }}>
                    {posts.map((p) => (
                      <a key={p.id} href={`/app/library/${p.id}`} style={{ display: "block", aspectRatio: "4 / 5", borderRadius: 10, overflow: "hidden", background: "var(--p-color-bg-surface-secondary)", position: "relative" }} title={p.caption || ""}>
                        {p.thumb && <img src={p.thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                        {p.contentType === "VIDEO" && <span style={{ position: "absolute", right: 6, bottom: 6, background: "rgba(0,0,0,.6)", color: "#fff", borderRadius: 999, fontSize: 11, padding: "2px 7px" }}>Video</span>}
                      </a>
                    ))}
                  </div>
                )}
                <Box>
                  <Text as="p" variant="bodySm" tone="subdued">To remove one, open it from Submissions → Approved and delete it there.</Text>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
