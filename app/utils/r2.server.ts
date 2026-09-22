import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "ugme-dev";

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Slugify a string for use in R2 object keys.
 * Lowercases, replaces non-alphanumeric with hyphens, trims hyphens.
 */
function slugify(str: string, maxLen = 60): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

/**
 * Build an object key for a submission upload.
 * Format: {shopDomain}/{campaign-slug}/submissions/{submissionId}/{filename}
 *
 * shopDomain  – e.g. "my-store.myshopify.com"
 * campaignName – human-readable campaign title, slugified
 * submissionId – CUID, keeps each submission's files unique
 * filename     – original upload filename, sanitised
 */
export function buildObjectKey(
  shopDomain: string,
  campaignName: string,
  submissionId: string,
  filename: string,
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `${shopDomain}/${slugify(campaignName)}/submissions/${submissionId}/${safe}`;
}

/**
 * Generate a presigned PUT URL so the client can upload directly to R2.
 * Expires in 10 minutes by default.
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 600,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Generate a presigned GET URL so the merchant can view/download the content.
 * Expires in 1 hour by default.
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Delete an object from R2 (e.g. on submission rejection).
 */
export async function deleteObject(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });

  await r2Client.send(command);
}

/**
 * Extract the R2 object key from a stored contentUrl.
 * contentUrl format: r2://shops/xxx/campaigns/yyy/submissions/zzz/file.mp4
 */
export function extractKeyFromContentUrl(contentUrl: string): string | null {
  if (!contentUrl.startsWith("r2://")) return null;
  return contentUrl.slice(5); // strip "r2://"
}

/**
 * Upload a file buffer directly to R2 (server-side upload).
 * Used when Shopify's proxy strips <script> tags, preventing client-side uploads.
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await r2Client.send(command);
}
