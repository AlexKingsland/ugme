/**
 * One-off: create poster thumbnails for submissions that don't have one yet
 * (uploaded before thumbnails were generated at upload time).
 *
 *   npm run posters:backfill            # approved submissions only
 *   npm run posters:backfill -- --all   # every submission with a file
 *
 * Needs ffmpeg + ffprobe on PATH. ffmpeg reads the video straight from R2 via a
 * presigned URL using range requests, so it doesn't download whole files.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { extractKeyFromContentUrl, getPresignedDownloadUrl, posterKeyFor, uploadToR2 } from "../app/utils/r2.server";

const run = promisify(execFile);
const prisma = new PrismaClient();
const POSTER_MAX = 800;
const all = process.argv.includes("--all");

async function makePoster(url: string): Promise<Buffer> {
  const scale = `scale='if(gt(iw,ih),min(${POSTER_MAX},iw),-2)':'if(gt(iw,ih),-2,min(${POSTER_MAX},ih))'`;
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", "0.3", "-i", url, "-vf", `thumbnail=24,${scale}`, "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
  );
  if (!stdout.length) throw new Error("ffmpeg produced no image");
  return stdout as Buffer;
}

async function probeDuration(url: string): Promise<number | null> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url], { timeout: 60_000 });
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  } catch {
    return null;
  }
}

const subs = await prisma.submission.findMany({
  where: {
    thumbnailUrl: null,
    contentUrl: { startsWith: "r2://" },
    NOT: { contentUrl: "r2://pending" },
    ...(all ? {} : { status: "APPROVED" }),
  },
  select: { id: true, contentUrl: true, contentType: true, durationSecs: true },
});

console.log(`Found ${subs.length} submission(s) without a poster${all ? "" : " (approved only)"}.`);
let ok = 0;
for (const s of subs) {
  const key = extractKeyFromContentUrl(s.contentUrl);
  if (!key) continue;
  try {
    const url = await getPresignedDownloadUrl(key, 600);
    const jpg = await makePoster(url);
    const posterKey = posterKeyFor(key);
    await uploadToR2(posterKey, jpg, "image/jpeg");
    const durationSecs = s.contentType === "VIDEO" && !s.durationSecs ? await probeDuration(url) : s.durationSecs;
    await prisma.submission.update({
      where: { id: s.id },
      data: { thumbnailUrl: `r2://${posterKey}`, durationSecs },
    });
    ok++;
    console.log(`✓ ${s.id}  ${(jpg.length / 1024).toFixed(0)} KB${durationSecs ? `  ${durationSecs}s` : ""}`);
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string };
    const detail = String(e.stderr || "").trim().split("\n").pop() || String(e.message || err).split("\n")[0];
    console.warn(`✗ ${s.id}  ${detail}`);
  }
}
console.log(`Done: ${ok}/${subs.length} posters created.`);
await prisma.$disconnect();
