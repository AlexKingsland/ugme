/**
 * Shared thumbnail component for submission media.
 * Renders a video first-frame or photo thumbnail with optional duration badge.
 * Used by the dashboard (Recent Submissions) and the library list.
 */

interface SubmissionThumbnailProps {
  contentType: "VIDEO" | "PHOTO";
  contentUrl: string;
  /** Duration in seconds — shown as an overlay badge on videos */
  durationSecs?: number | null;
  /** Pixel size of the square thumbnail (default 64) */
  size?: number;
}

function formatDuration(secs: number | null | undefined): string {
  if (!secs) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

export function SubmissionThumbnail({
  contentType,
  contentUrl,
  durationSecs,
  size = 64,
}: SubmissionThumbnailProps) {
  const hasUrl = contentUrl?.startsWith("http");
  const radius = Math.round(size * 0.125); // 8px at 64

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: radius,
        overflow: "hidden",
        background: "#1a1a1a",
        flexShrink: 0,
      }}
    >
      {contentType === "VIDEO" && hasUrl ? (
        <video
          src={contentUrl}
          preload="metadata"
          muted
          style={{
            width: size,
            height: size,
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : contentType === "PHOTO" && hasUrl ? (
        <img
          src={contentUrl}
          alt=""
          style={{
            width: size,
            height: size,
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <div
          style={{
            width: size,
            height: size,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#666",
            fontSize: 10,
          }}
        >
          {contentType === "VIDEO" ? "VID" : "IMG"}
        </div>
      )}
      {contentType === "VIDEO" && durationSecs && (
        <div
          style={{
            position: "absolute",
            bottom: 2,
            right: 4,
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 4px",
            borderRadius: 3,
          }}
        >
          {formatDuration(durationSecs)}
        </div>
      )}
    </div>
  );
}
