import * as React from "react";
import { peekLoaded, preloadMedia, releaseMedia, retainMedia } from "./media-loader";
import { MediaOverlay } from "./overlay";
import { InfiniteScene, type SceneHandlers } from "./scene";
import type { CanvasOptions, MediaItem, SelectedMedia } from "./types";
import { isTouchDevice } from "./utils";
import { VideoPool } from "./video-pool";

const KEY_MAP: Record<string, string> = {
  w: "forward", arrowup: "forward",
  s: "backward", arrowdown: "backward",
  a: "left", arrowleft: "left",
  d: "right", arrowright: "right",
  e: "up", q: "down",
};

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const ExpandIcon = ({ full }: { full: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
  </svg>
);

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; media: MediaItem[] };

export function mediaUrl(options: CanvasOptions): string {
  const url = new URL(options.endpoint || "/apps/social-wall/canvas", window.location.origin);
  if (options.wall) url.searchParams.set("wall", options.wall);
  else if (options.campaigns?.length) url.searchParams.set("campaigns", options.campaigns.join(","));
  if (options.product) url.searchParams.set("product", options.product);
  return url.toString();
}

type WallInfo = { spotsLeft?: number | null } | null;
type MediaResponse = { items?: MediaItem[]; wall?: WallInfo };

async function fetchMedia(options: CanvasOptions): Promise<MediaResponse> {
  const url = new URL(mediaUrl(options));
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" }, credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MediaResponse;
}

export function UgmeCanvasApp({ options, root }: { options: CanvasOptions; root: HTMLElement }) {
  const [state, setState] = React.useState<LoadState>(
    options.media ? { status: "ready", media: options.media } : { status: "loading" },
  );
  const [selected, setSelected] = React.useState<SelectedMedia | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [progress, setProgress] = React.useState<{ loaded: number; total: number } | null>(null);
  const [hintVisible, setHintVisible] = React.useState(options.showHint !== false);
  const [full, setFull] = React.useState(false);
  // The wall's submission limit is reached → no "Share yours" button
  const [wallFull, setWallFull] = React.useState(false);

  const pool = React.useMemo(() => new VideoPool(), []);
  const pausedRef = React.useRef(false);
  const keysRef = React.useRef(new Set<string>());
  const background = options.background || "#ffffff";

  // ── data ──
  React.useEffect(() => {
    if (options.media) return;
    let alive = true;
    // The loader script usually started this request already (in parallel with
    // downloading this bundle) — reuse it if so.
    const prefetched = (root as HTMLElement & { __ugmeData?: Promise<MediaResponse> | null }).__ugmeData;
    (prefetched ? prefetched.catch(() => fetchMedia(options)) : fetchMedia(options))
      .then((data) => {
        if (!alive) return;
        setWallFull(data.wall?.spotsLeft === 0);
        setState({ status: "ready", media: data.items ?? [] });
      })
      .catch((err) => alive && setState({ status: "error", message: String(err?.message || err) }));
    return () => {
      alive = false;
    };
  }, [options.endpoint, options.campaigns, options.wall, options.product, options.media]);

  // ── preload all thumbnails, then reveal the wall in one go ──
  React.useEffect(() => {
    if (state.status !== "ready" || !state.media.length) return;
    let alive = true;
    preloadMedia(state.media, (loaded, total) => alive && setProgress({ loaded, total })).then(
      () => alive && setRevealed(true),
    );
    return () => {
      alive = false;
    };
  }, [state]);

  React.useEffect(() => {
    retainMedia();
    return () => {
      pool.dispose();
      releaseMedia(); // textures are shared between walls; free them when the last one goes
    };
  }, [pool]);

  // ── keyboard (only while the embed has focus, so we never hijack the store's inputs) ──
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.key.toLowerCase()];
      if (!k || pausedRef.current) return;
      e.preventDefault();
      keysRef.current.add(k);
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.key.toLowerCase()];
      if (k) keysRef.current.delete(k);
    };
    const blur = () => keysRef.current.clear();
    root.addEventListener("keydown", down);
    root.addEventListener("keyup", up);
    root.addEventListener("blur", blur, true);
    return () => {
      root.removeEventListener("keydown", down);
      root.removeEventListener("keyup", up);
      root.removeEventListener("blur", blur, true);
    };
  }, [root]);

  // ── fullscreen toggle ──
  React.useEffect(() => {
    root.classList.toggle("ugme-canvas--full", full);
    if (!full) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !pausedRef.current && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [full, root]);

  const close = React.useCallback(() => {
    setSelected((cur) => {
      if (cur?.video) pool.give(cur.video);
      return null;
    });
    pausedRef.current = false;
  }, [pool]);

  const handlers = React.useMemo<SceneHandlers>(
    () => ({
      pausedRef,
      keysRef,
      onFirstInteraction: () => setHintVisible(false),
      onPrefetch: (item) => pool.prefetch(item.src),
      onSelect: (item, origin) => {
        pausedRef.current = true;
        setHintVisible(false);
        let video: HTMLVideoElement | null = null;
        let poster: string | null = item.thumb || null;
        if (item.type === "video") {
          video = pool.take(item.src);
          if (!poster) {
            const loaded = peekLoaded(item);
            if (loaded && !loaded.failed) poster = loaded.canvas.toDataURL("image/jpeg", 0.85);
          }
          if (poster) video.poster = poster;
          video.controls = true;
          video.loop = true;
          video.muted = false;
          video.currentTime = 0;
          // play() inside the tap gesture → sound allowed on iOS/Android.
          video.play().catch(() => {
            video!.muted = true;
            video!.play().catch(() => {});
          });
        }
        setSelected({ item, origin, video, poster });
      },
    }),
    [pool],
  );

  const touch = React.useMemo(isTouchDevice, []);
  const hint = touch ? "Drag to explore · Pinch to zoom · Tap to play" : "Drag to explore · Scroll to zoom · Click to play";

  return (
    <>
      {state.status === "ready" && state.media.length > 0 && revealed && (
        <InfiniteScene media={state.media} background={background} handlers={handlers} />
      )}

      {(state.status === "loading" || (state.status === "ready" && state.media.length > 0 && !revealed)) && (
        <div className="ugme-canvas__state">
          <div className="ugme-canvas__loading">
            <span className="ugme-canvas__spinner" />
            {progress && progress.total > 8 && (
              <span className="ugme-canvas__count">
                {progress.loaded} / {progress.total}
              </span>
            )}
          </div>
        </div>
      )}
      {state.status === "error" && (
        <div className="ugme-canvas__state">
          <div>
            <b>Couldn’t load content</b>
            {options.designMode ? state.message : "Please refresh the page."}
          </div>
        </div>
      )}
      {state.status === "ready" && state.media.length === 0 && (
        <div className="ugme-canvas__state">
          <div className="ugme-empty">
            <div className="ugme-empty__tiles" aria-hidden="true">
              <span className="ugme-empty__tile ugme-empty__tile--l"><PlayIcon /></span>
              <span className="ugme-empty__tile ugme-empty__tile--c"><PlayIcon /></span>
              <span className="ugme-empty__tile ugme-empty__tile--r"><PlayIcon /></span>
            </div>
            <h3 className="ugme-empty__title">{options.designMode ? "No approved posts yet" : "Be the first on the wall"}</h3>
            <p className="ugme-empty__text">
              {options.designMode
                ? "Approved submissions from this wall campaign will appear here."
                : "Bought something you love? Share a video of it and get featured here."}
            </p>
            {options.share && options.shareUrl && !wallFull && (
              <a className="ugme-empty__cta" href={options.shareUrl}>
                <ShareIcon />
                <span>{options.shareLabel || "Share yours"}</span>
              </a>
            )}
          </div>
        </div>
      )}

      {state.status === "ready" && state.media.length > 0 && revealed && (
        <>
          {options.showHint !== false && (
            <div className={`ugme-canvas__chip${hintVisible ? "" : " ugme-canvas__chip--hidden"}`}>{hint}</div>
          )}
          {options.share && options.shareUrl && !wallFull && (
            <a className="ugme-canvas__share" href={options.shareUrl}>
              <ShareIcon />
              <span>{options.shareLabel || "Share yours"}</span>
            </a>
          )}
          <button
            type="button"
            className="ugme-canvas__btn"
            aria-label={full ? "Exit full screen" : "Full screen"}
            onClick={() => setFull((f) => !f)}
          >
            <ExpandIcon full={full} />
          </button>
        </>
      )}

      {selected && <MediaOverlay selected={selected} onClose={close} showProducts={options.showProducts !== false} />}
    </>
  );
}
