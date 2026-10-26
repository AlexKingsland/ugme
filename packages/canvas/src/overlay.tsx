import * as React from "react";
import { createPortal } from "react-dom";
import { ProductCards } from "./products";
import type { SelectedMedia } from "./types";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/**
 * Full-screen player. The <video> element is created (and play() called) in the
 * tap handler before this renders — here we just adopt it into the DOM.
 */
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export function MediaOverlay({
  selected,
  onClose,
  showProducts = true,
}: {
  selected: SelectedMedia;
  onClose: () => void;
  showProducts?: boolean;
}) {
  const mediaRef = React.useRef<HTMLDivElement>(null);
  const [buffering, setBuffering] = React.useState(selected.item.type === "video");
  const { item, video, origin } = selected;

  React.useEffect(() => {
    const host = mediaRef.current;
    if (!host || !video) return;
    host.appendChild(video);
    const onPlaying = () => setBuffering(false);
    const onWaiting = () => setBuffering(true);
    if (!video.paused && video.readyState >= 3) setBuffering(false);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      if (video.parentNode === host) host.removeChild(video);
    };
  }, [video]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="ugme-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={item.caption || (item.type === "video" ? "Customer video" : "Customer photo")}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <button type="button" className="ugme-overlay__close" onClick={onClose} aria-label="Close">
        <CloseIcon />
      </button>
      <div
        className="ugme-overlay__frame"
        style={
          {
            "--ugme-dx": `${Math.round(origin.x - window.innerWidth / 2)}px`,
            "--ugme-dy": `${Math.round(origin.y - window.innerHeight / 2)}px`,
          } as React.CSSProperties
        }
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          className={`ugme-overlay__media${showProducts && item.products?.length ? " ugme-overlay__media--with-products" : ""}`}
          ref={mediaRef}
        >
          {item.type === "image" && <img src={item.src} alt={item.caption || ""} />}
          {item.type === "video" && buffering && (
            <div className="ugme-overlay__buffer">
              <span className="ugme-canvas__spinner" />
            </div>
          )}
        </div>
        <div className="ugme-overlay__meta">
          {item.verified !== false && (
            <span className="ugme-overlay__verified">
              <CheckIcon />
              Verified buyer
            </span>
          )}
          {item.author && <span className="ugme-overlay__author">{item.author}</span>}
        </div>
        {showProducts && item.products && item.products.length > 0 && <ProductCards products={item.products} />}
      </div>
    </div>,
    document.body,
  );
}
