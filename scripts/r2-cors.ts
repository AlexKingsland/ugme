/**
 * Enables CORS on the R2 bucket so the storefront canvas can use submission
 * images / video frames as WebGL textures (the browser refuses cross-origin
 * pixels without it). Objects stay private: they're still only reachable via
 * presigned URLs. Safe to re-run.
 *
 *   npm run r2:cors              (uses R2_* vars from .env)
 *
 * Needs an R2 token with bucket *admin* rights. With an object read/write token
 * you'll get AccessDenied — set the same policy in the Cloudflare dashboard instead
 * (R2 → bucket → Settings → CORS policy).
 *
 * Existing CORS rules on the bucket are kept; the read rule is added if missing.
 */
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand, type CORSRule } from "@aws-sdk/client-s3";

const bucket = process.env.R2_BUCKET_NAME || "ugme-dev";
const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

let existing: CORSRule[] = [];
try {
  existing = (await client.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules ?? [];
} catch {
  existing = []; // no CORS config yet
}

const canvasRule: CORSRule = {
  ID: "ugme-canvas-read",
  // Storefronts can live on any custom domain, so allow all origins for reads.
  AllowedOrigins: ["*"],
  // PUT: customers' browsers upload straight to R2 via presigned URLs (submit page)
  AllowedMethods: ["GET", "HEAD", "PUT"],
  AllowedHeaders: ["*"],
  ExposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
  MaxAgeSeconds: 86400,
};

const isCanvasRule = (r: CORSRule) =>
  r.ID === canvasRule.ID || (r.AllowedOrigins?.join() === "*" && ["GET,HEAD", "GET,HEAD,PUT"].includes(r.AllowedMethods?.slice().sort().join() ?? ""));
const rules = [...existing.filter((r) => !isCanvasRule(r)), canvasRule];
await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }));

const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
console.log(`✓ CORS set on ${bucket}:`, JSON.stringify(current.CORSRules, null, 2));
