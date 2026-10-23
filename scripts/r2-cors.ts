/**
 * Enables CORS on the R2 bucket so the storefront canvas can use submission
 * images / video frames as WebGL textures (the browser refuses cross-origin
 * pixels without it). Objects stay private: they're still only reachable via
 * presigned URLs. Safe to re-run.
 *
 *   npm run r2:cors              (uses R2_* vars from .env)
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
  AllowedMethods: ["GET", "HEAD"],
  AllowedHeaders: ["*"],
  ExposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
  MaxAgeSeconds: 86400,
};

const isCanvasRule = (r: CORSRule) =>
  r.ID === canvasRule.ID || (r.AllowedOrigins?.join() === "*" && r.AllowedMethods?.slice().sort().join() === "GET,HEAD");
const rules = [...existing.filter((r) => !isCanvasRule(r)), canvasRule];
await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }));

const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
console.log(`✓ CORS set on ${bucket}:`, JSON.stringify(current.CORSRules, null, 2));
