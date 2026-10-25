/**
 * Loads every media item as a small CanvasTexture (max 512px) so the 3D scene
 * only ever holds lightweight thumbnails — videos are never decoded on the canvas.
 *
 * - Photos: image is downscaled into a canvas.
 * - Videos with a thumb: thumb is downscaled + a play badge drawn on.
 * - Videos without a thumb: first frame is grabbed client-side (requires CORS on
 *   the bucket), then the element is released. Concurrency-limited.
 */
import * as THREE from "three";
import type { MediaItem } from "./types";

// Longest side of each tile texture. Big enough to stay sharp when a tile is
// zoomed to fill a phone screen; smaller on touch devices to respect GPU memory.
const IS_TOUCH =
  typeof navigator !== "undefined" &&
  (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
const MAX_TEX = IS_TOUCH ? 800 : 1024; // posters are generated at 800px
const FALLBACK_ASPECT: Record<MediaItem["type"], number> = { image: 1, video: 9 / 16 };

export type LoadedMedia = {
  texture: THREE.CanvasTexture;
  aspect: number;
  canvas: HTMLCanvasElement;
  failed: boolean;
};

const cache = new Map<string, Promise<LoadedMedia>>();

// ── tiny concurrency queue ──────────────────────────────────────
function makeQueue(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (active >= limit) return;
    const run = waiting.shift();
    if (run) {
      active++;
      run();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
const imageQueue = makeQueue(12); // thumbnails are small; HTTP/2 multiplexes them
const videoQueue = makeQueue(2);

// ── drawing ─────────────────────────────────────────────────────
function drawToCanvas(source: CanvasImageSource, w: number, h: number, isVideo: boolean) {
  const scale = Math.min(1, MAX_TEX / Math.max(w, h));
  const cw = Math.max(2, Math.round(w * scale));
  const ch = Math.max(2, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, cw, ch);
  if (isVideo) drawPlayBadge(ctx, cw, ch);
  return canvas;
}

function drawPlayBadge(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const r = Math.max(10, Math.min(w, h) * 0.09);
  const pad = r * 0.6;
  const cx = w - pad - r;
  const cy = h - pad - r;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  const t = r * 0.42;
  ctx.moveTo(cx - t * 0.7, cy - t);
  ctx.lineTo(cx - t * 0.7, cy + t);
  ctx.lineTo(cx + t * 1.05, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * True when the frame isn't really there yet: fully transparent (desktop browsers
 * before decode) or solid near-black (iOS Safari before decode).
 */
function isEmptyFrame(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(4, Math.floor((w * h) / 400)) * 4;
  let maxLum = 0;
  let opaque = false;
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] !== 0) opaque = true;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (lum > maxLum) maxLum = lum;
  }
  return !opaque || maxLum < 12;
}

function placeholderCanvas(item: MediaItem) {
  const aspect = item.width && item.height ? item.width / item.height : FALLBACK_ASPECT[item.type];
  const h = 512;
  const w = Math.round(h * aspect);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#d9d9d6");
  g.addColorStop(1, "#bdbdb8");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  if (item.type === "video") drawPlayBadge(ctx, w, h);
  return canvas;
}

function toTexture(canvas: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ── loaders ─────────────────────────────────────────────────────
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

function grabVideoFrame(url: string, timeoutMs = 20000): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    // iOS Safari only decodes frames for videos that are muted + inline and, in
    // practice, attached to the page and briefly played. Without that, drawImage()
    // returns a solid BLACK frame (not a transparent one).
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    video.style.cssText =
      "position:fixed;left:-10000px;top:0;width:360px;height:640px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);

    let done = false;
    let attempts = 0;
    let seekTo = 0.5;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    };
    const fail = (why: string) => {
      if (done) return;
      cleanup();
      reject(new Error(`${why}: ${url}`));
    };
    const timer = setTimeout(() => fail("poster timeout"), timeoutMs);

    const tryDraw = () => {
      if (done) return;
      let canvas: HTMLCanvasElement;
      try {
        canvas = drawToCanvas(video, video.videoWidth || 720, video.videoHeight || 1280, false);
      } catch (e) {
        return fail(`poster draw failed (CORS) ${String(e)}`);
      }
      if (isEmptyFrame(canvas)) {
        if (attempts++ < 10) {
          // Not decoded yet (or a genuinely dark first frame): wait, and every few
          // tries step a little further into the clip.
          if (attempts % 3 === 0 && Number.isFinite(video.duration)) {
            seekTo = Math.min(seekTo + 0.75, Math.max(0, video.duration - 0.1));
            video.currentTime = seekTo;
            return; // 'seeked' will call whenFrameReady again
          }
          setTimeout(tryDraw, 150);
          return;
        }
        return fail("poster frame stayed blank/black");
      }
      drawPlayBadge(canvas.getContext("2d")!, canvas.width, canvas.height);
      cleanup();
      resolve(canvas);
    };

    const whenFrameReady = () => {
      if (done) return;
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(() => tryDraw());
        setTimeout(tryDraw, 400); // rVFC may not fire for a paused seek; keep a fallback
      } else {
        setTimeout(tryDraw, 80);
      }
    };

    video.addEventListener("seeked", () => {
      if (done) return;
      if (video.readyState >= 2) whenFrameReady();
      else video.addEventListener("loadeddata", whenFrameReady, { once: true });
    });

    video.addEventListener("loadedmetadata", () => {
      if (done) return;
      seekTo = Number.isFinite(video.duration) ? Math.min(0.5, video.duration / 3) : 0.1;
      const seek = () => {
        if (done) return;
        video.pause();
        video.currentTime = seekTo;
      };
      // Kick the decoder (needed on iOS), then seek to the poster time.
      const p = video.play();
      if (p && typeof p.then === "function") {
        p.then(() => setTimeout(seek, 50)).catch(seek);
      } else {
        seek();
      }
    });
    video.addEventListener("error", () => fail("video error"));
    video.src = url;
    video.load();
  });
}

const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

const MAX_FALLBACK_BYTES = 80 * 1024 * 1024;

async function grabVideoFrameUncached(url: string): Promise<HTMLCanvasElement> {
  const res = await fetch(url, { mode: "cors", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_FALLBACK_BYTES) throw new Error("video too large for poster fallback");
  const blobUrl = URL.createObjectURL(await res.blob());
  try {
    return await grabVideoFrame(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function load(item: MediaItem): Promise<LoadedMedia> {
  const isVideo = item.type === "video";
  try {
    let canvas: HTMLCanvasElement;
    const imgUrl = isVideo ? item.thumb : item.thumb || item.src;
    if (imgUrl) {
      const img = await imageQueue(() => loadImage(imgUrl));
      canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight, isVideo);
    } else {
      canvas = await videoQueue(() =>
        grabVideoFrame(item.src).catch(async (err) => {
          // Stale non-CORS copy in the HTTP cache: re-fetch bypassing it. Only for
          // CORS-type failures, and never on phones (would download the whole file).
          const msg = String(err?.message || err);
          const corsLike = msg.includes("CORS") || msg.includes("video error");
          if (!corsLike || isMobile()) throw err;
          console.warn("[ugme-canvas] poster retry without cache", err);
          return grabVideoFrameUncached(item.src);
        }),
      );
    }
    return { canvas, texture: toTexture(canvas), aspect: canvas.width / canvas.height, failed: false };
  } catch (err) {
    console.warn("[ugme-canvas]", err);
    const canvas = placeholderCanvas(item);
    return { canvas, texture: toTexture(canvas), aspect: canvas.width / canvas.height, failed: true };
  }
}

export function getMedia(item: MediaItem): Promise<LoadedMedia> {
  let p = cache.get(item.id);
  if (!p) {
    p = load(item);
    cache.set(item.id, p);
  }
  return p;
}

/** Poster for the overlay player — reuse the thumbnail we already drew. */
export async function getPosterDataUrl(item: MediaItem): Promise<string | null> {
  if (item.thumb) return item.thumb;
  const p = cache.get(item.id);
  if (!p) return null;
  const m = await p;
  return m.failed ? null : m.canvas.toDataURL("image/jpeg", 0.85);
}

export function peekLoaded(item: MediaItem): LoadedMedia | null {
  return loadedSync.get(item.id) ?? null;
}
const loadedSync = new Map<string, LoadedMedia>();
export function rememberLoaded(item: MediaItem, m: LoadedMedia) {
  loadedSync.set(item.id, m);
}

let liveWalls = 0;
export function retainMedia() {
  liveWalls++;
}
export function releaseMedia() {
  liveWalls = Math.max(0, liveWalls - 1);
  if (liveWalls === 0) disposeAll();
}

function disposeAll() {
  for (const p of cache.values()) p.then((m) => m.texture.dispose()).catch(() => {});
  cache.clear();
  loadedSync.clear();
}

/**
 * Warm every item's texture before the wall is revealed, so tiles appear
 * together instead of popping in one by one. Resolves once everything with a
 * ready-made thumbnail is loaded (fast), giving slower client-side video frame
 * grabs a short extra grace period — and never waits longer than `maxWaitMs`.
 */
export function preloadMedia(
  items: MediaItem[],
  onProgress: (loaded: number, total: number) => void,
  maxWaitMs = 6000,
): Promise<void> {
  const total = items.length;
  let settled = 0;
  const track = (item: MediaItem) =>
    getMedia(item)
      .then((m) => rememberLoaded(item, m))
      .finally(() => onProgress(++settled, total));

  const fast = items.filter((i) => i.type === "image" || !!i.thumb);
  const slow = items.filter((i) => !(i.type === "image" || !!i.thumb));
  const fastDone = Promise.all(fast.map(track));
  const slowDone = Promise.all(slow.map(track));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return Promise.race([
    fastDone.then(() => (slow.length ? Promise.race([slowDone, sleep(1500)]) : undefined)).then(() => undefined),
    sleep(maxWaitMs),
  ]);
}
