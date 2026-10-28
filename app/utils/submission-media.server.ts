/**
 * Media URLs for the merchant admin.
 *
 * Only APPROVED submissions can be downloaded — usage rights are granted on
 * approval. Pending submissions get a short-lived, play-only URL for review
 * (no download URL is ever issued for them).
 */
import { extractKeyFromContentUrl, getPresignedDownloadUrl } from "./r2.server";

const REVIEW_URL_TTL = 15 * 60; // pending: just long enough to review
const APPROVED_URL_TTL = 60 * 60;

export async function mediaUrlsFor(s: { id: string; status: string; contentUrl: string; contentType: string }) {
  const key = extractKeyFromContentUrl(s.contentUrl);
  if (!key || key === "pending") return { viewUrl: s.contentUrl, downloadUrl: null as string | null };
  const approved = s.status === "APPROVED";
  const viewUrl = await getPresignedDownloadUrl(key, approved ? APPROVED_URL_TTL : REVIEW_URL_TTL).catch(() => s.contentUrl);
  if (!approved) return { viewUrl, downloadUrl: null as string | null };
  const ext = (key.split(".").pop() || (s.contentType === "VIDEO" ? "mp4" : "jpg")).slice(0, 5);
  const downloadUrl = await getPresignedDownloadUrl(key, APPROVED_URL_TTL, { downloadName: `submission-${s.id.slice(-8)}.${ext}` }).catch(() => null);
  return { viewUrl, downloadUrl };
}
