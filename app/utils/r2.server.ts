import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
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
  // Newer AWS SDKs add a CRC32 checksum of an *empty* body to presigned PUT URLs,
  // which makes browser uploads of real files fail. Only checksum when required.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
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

/**
 * Look up an uploaded object's size/type (used to confirm a direct browser upload
 * actually landed before creating the submission). Returns null if missing.
 */
export async function headObject(key: string): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const res = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? null };
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw err;
  }
}

// ── Multipart uploads (large files, uploaded in parallel parts from the browser) ──

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const res = await r2Client.send(
    new CreateMultipartUploadCommand({ Bucket: R2_BUCKET_NAME, Key: key, ContentType: contentType }),
  );
  if (!res.UploadId) throw new Error("R2 did not return an UploadId");
  return res.UploadId;
}

/** Presigned PUT URL for one part (partNumber is 1-based). */
export async function getPresignedPartUrl(key: string, uploadId: string, partNumber: number, expiresIn = 6 * 3600) {
  return getSignedUrl(
    r2Client,
    new UploadPartCommand({ Bucket: R2_BUCKET_NAME, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn },
  );
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
): Promise<void> {
  await r2Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await r2Client.send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET_NAME, Key: key, UploadId: uploadId }));
}

// ── Posters (small thumbnails stored next to each upload) ──

/** Poster object key for an uploaded file: same folder, `poster.jpg`. */
export function posterKeyFor(contentKey: string): string {
  const slash = contentKey.lastIndexOf("/");
  return `${contentKey.slice(0, slash + 1)}poster.jpg`;
}

const STABLE_WINDOW_MS = 6 * 60 * 60 * 1000; // URLs stay identical for 6h windows

/**
 * Presigned GET URL that is *identical* for every request in the same 6-hour
 * window (signing date is rounded down), so browsers and CDNs can cache the
 * file instead of re-downloading it on every page view. Valid for 6–12h.
 */
export async function getCacheableDownloadUrl(key: string, maxAgeSecs = 6 * 60 * 60): Promise<string> {
  const windowStart = new Date(Math.floor(Date.now() / STABLE_WINDOW_MS) * STABLE_WINDOW_MS);
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ResponseCacheControl: `public, max-age=${maxAgeSecs}, immutable`,
  });
  return getSignedUrl(r2Client, command, {
    expiresIn: (2 * STABLE_WINDOW_MS) / 1000,
    signingDate: windowStart,
  });
}
