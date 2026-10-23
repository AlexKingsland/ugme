/**
 * Keeps a few <video> elements warm so a tap can start playback instantly.
 * prefetch() is called for whatever video tile the user is hovering (desktop)
 * or resting near the centre of the view (touch). take() hands the warm
 * element to the overlay — or a fresh one if nothing was prefetched.
 */
const MAX_WARM = 3;

function create(src: string) {
  const v = document.createElement("video");
  // Must match the poster grabber's CORS mode. R2 doesn't send `Vary: Origin`, so a
  // plain (non-CORS) request here would get cached and then break later CORS
  // reads of the same URL (thumbnails turning into black placeholders).
  v.crossOrigin = "anonymous";
  v.preload = "auto";
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.dataset.ugmeSrc = src;
  v.src = src;
  return v;
}

function release(v: HTMLVideoElement) {
  v.pause();
  v.removeAttribute("src");
  v.load();
}

export class VideoPool {
  private warm = new Map<string, HTMLVideoElement>();

  prefetch(src: string) {
    const existing = this.warm.get(src);
    if (existing) {
      // refresh LRU position
      this.warm.delete(src);
      this.warm.set(src, existing);
      return;
    }
    const v = create(src);
    v.muted = true;
    v.load();
    this.warm.set(src, v);
    while (this.warm.size > MAX_WARM) {
      const [oldSrc, oldEl] = this.warm.entries().next().value as [string, HTMLVideoElement];
      this.warm.delete(oldSrc);
      release(oldEl);
    }
  }

  take(src: string) {
    const v = this.warm.get(src);
    if (v) {
      this.warm.delete(src);
      return v;
    }
    return create(src);
  }

  /** Return a played element to the pool (keeps its buffer for a quick re-open). */
  give(v: HTMLVideoElement) {
    v.pause();
    v.controls = false;
    v.muted = true;
    const src = v.dataset.ugmeSrc;
    if (!src) return;
    this.warm.set(src, v);
    while (this.warm.size > MAX_WARM) {
      const [oldSrc, oldEl] = this.warm.entries().next().value as [string, HTMLVideoElement];
      this.warm.delete(oldSrc);
      release(oldEl);
    }
  }

  dispose() {
    for (const v of this.warm.values()) release(v);
    this.warm.clear();
  }
}
