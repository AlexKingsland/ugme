/**
 * Sample posts for the theme editor: an active wall with no approved posts yet shows
 * these instead of an empty state, so the merchant can see what the wall will look
 * like while placing it. Drawn in the browser (no files to host); shoppers never see
 * them — the app only uses them when `designMode` is on.
 */
import type { MediaItem } from "./types";

const PALETTES: [string, string][] = [
  ["#f3d9c9", "#d9a58a"],
  ["#dfe7d6", "#a9bf98"],
  ["#d8e3ee", "#93aac4"],
  ["#efe3c8", "#cfb27a"],
  ["#e9d6e3", "#bf93ad"],
  ["#d6e6e3", "#86b3ab"],
  ["#ece7e1", "#b9aea3"],
  ["#f1dcd2", "#c98f80"],
];

// Portrait photos, square photos and tall "video-shaped" tiles, like a real wall
const SHAPES: { w: number; h: number; play: boolean }[] = [
  { w: 640, h: 800, play: false },
  { w: 540, h: 960, play: true },
  { w: 720, h: 720, play: false },
  { w: 640, h: 800, play: false },
  { w: 540, h: 960, play: true },
  { w: 800, h: 600, play: false },
];

const NAMES = ["Sam", "Priya", "Jordan", "Maya", "Leo", "Ava", null, "Noah", "Zoe", null];
const NOTES = [
  "Sample post. Your customers' approved photos and videos will appear here.",
  "Sample post. Approve submissions in the Social Wall app to fill your wall.",
  null,
];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTile(i: number, w: number, h: number, play: boolean): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const [top, bottom] = PALETTES[i % PALETTES.length];
  const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // A soft "product" on a surface: a shadow, a rounded body and a lid
  const s = Math.min(w, h);
  const cx = w * (0.42 + ((i * 37) % 17) / 100);
  const base = h * 0.7;
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.beginPath();
  ctx.ellipse(cx, base, s * 0.2, s * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  roundRect(ctx, cx - s * 0.13, base - s * 0.42, s * 0.26, s * 0.42, s * 0.05);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  roundRect(ctx, cx - s * 0.09, base - s * 0.5, s * 0.18, s * 0.09, s * 0.025);
  ctx.fill();
  // a background circle, like window light
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.22, s * 0.22, 0, Math.PI * 2);
  ctx.fill();

  if (play) {
    const r = s * 0.11;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.38, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    const t = r * 0.42;
    ctx.moveTo(w / 2 - t * 0.7, h * 0.38 - t);
    ctx.lineTo(w / 2 - t * 0.7, h * 0.38 + t);
    ctx.lineTo(w / 2 + t * 1.05, h * 0.38);
    ctx.closePath();
    ctx.fill();
  }

  // "SAMPLE" pill
  const fs = Math.round(s * 0.045);
  ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const label = "SAMPLE";
  const pw = ctx.measureText(label).width + fs * 1.6;
  const ph = fs * 1.9;
  ctx.fillStyle = "rgba(17,17,17,0.55)";
  roundRect(ctx, fs, fs, pw, ph, ph / 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, fs * 1.8, fs + ph / 2 + 1);

  try {
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

/** Sample posts for an empty wall in the theme editor. */
export function samplePosts(count = 18): MediaItem[] {
  const out: MediaItem[] = [];
  for (let i = 0; i < count; i++) {
    const shape = SHAPES[i % SHAPES.length];
    const src = drawTile(i, shape.w, shape.h, shape.play);
    if (!src) continue;
    const name = NAMES[i % NAMES.length];
    out.push({
      id: `sample-${i + 1}`,
      type: "image",
      src,
      width: shape.w,
      height: shape.h,
      caption: name ? `${name} · Sample post` : "Sample post",
      author: name,
      message: NOTES[i % NOTES.length],
      verified: true,
      products: [],
    });
  }
  return out;
}
