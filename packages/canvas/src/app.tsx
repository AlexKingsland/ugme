import * as React from "react";
import { peekLoaded, releaseMedia, retainMedia } from "./media-loader";
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

const ExpandIcon = ({ full }: { full: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
  </svg>
);

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; media: MediaItem[] };

async function fetchMedia(endpoint: string, campaigns: string[]): Promise<MediaItem[]> {
  const url = new URL(endpoint, window.location.origin);
  if (campaigns.length) url.searchParams.set("campaigns", campaigns.join(","));
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" }, credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { items?: MediaItem[] };
  return data.items ?? [];
}

export function UgmeCanvasApp({ options, root }: { options: CanvasOptions; root: HTMLElement }) {
  const [state, setState] = React.useState<LoadState>(
    options.media ? { status: "ready", media: options.media } : { status: "loading" },
  );
  const [selected, setSelected] = React.useState<SelectedMedia | null>(null);
  const [hintVisible, setHintVisible] = React.useState(options.showHint !== false);
  const [full, setFull] = React.useState(false);

  const pool = React.useMemo(() => new VideoPool(), []);
  const pausedRef = React.useRef(false);
  const keysRef = React.useRef(new Set<string>());
  const background = options.background || "#ffffff";

  // ── data ──
  React.useEffect(() => {
    if (options.media) return;
    let alive = true;
    fetchMedia(options.endpoint || "/apps/ugme/canvas", options.campaigns || [])
      .then((media) => alive && setState({ status: "ready", media }))
      .catch((err) => alive && setState({ status: "error", message: String(err?.message || err) }));
    return () => {
      alive = false;
    };
  }, [options.endpoint, options.campaigns, options.media]);

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
      {state.status === "ready" && state.media.length > 0 && (
        <InfiniteScene media={state.media} background={background} handlers={handlers} />
      )}

      {state.status === "loading" && (
        <div className="ugme-canvas__state">
          <span className="ugme-canvas__spinner" />
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
          <div>
            <b>No content yet</b>
            {options.designMode
              ? "Approved submissions from the selected campaigns will appear here. Pick campaigns in the block settings."
              : "Check back soon."}
          </div>
        </div>
      )}

      {state.status === "ready" && state.media.length > 0 && (
        <>
          {options.showHint !== false && (
            <div className={`ugme-canvas__chip${hintVisible ? "" : " ugme-canvas__chip--hidden"}`}>{hint}</div>
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

      {selected && <MediaOverlay selected={selected} onClose={close} />}
    </>
  );
}
