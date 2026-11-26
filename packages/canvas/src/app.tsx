import * as React from "react";
import { peekLoaded, preloadMedia, releaseMedia, retainMedia } from "./media-loader";
import { MediaOverlay } from "./overlay";
import { syncViewsToCart } from "./attribution";
import { InfiniteScene, type SceneHandlers } from "./scene";
import type { CanvasOptions, MediaItem, SelectedMedia } from "./types";
import { isTouchDevice } from "./utils";
import { VideoPool } from "./video-pool";
import { samplePosts } from "./samples";

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

const ArrowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// clip-path that crops the viewport down to a rect (where the wall sits on the page)
const insetFor = (r: DOMRect) => {
  const t = Math.max(0, r.top);
  const l = Math.max(0, r.left);
  const rt = Math.max(0, window.innerWidth - r.right);
  const b = Math.max(0, window.innerHeight - r.bottom);
  return `inset(${t}px ${rt}px ${b}px ${l}px round 12px)`;
};

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);


type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; media: MediaItem[] }
  /** Fewer posts than the block's minimum: banner (or nothing) instead of the wall */
  | { status: "below"; wall: WallInfo };

export function mediaUrl(options: CanvasOptions): string {
  const url = new URL(options.endpoint || "/apps/social-wall/canvas", window.location.origin);
  if (options.wall) url.searchParams.set("wall", options.wall);
  else if (options.campaigns?.length) url.searchParams.set("campaigns", options.campaigns.join(","));
  if (options.product) url.searchParams.set("product", options.product);
  return url.toString();
}

type WallInfo = {
  spotsLeft?: number | null;
  offer?: string | null;
  contentWord?: string;
  productTitle?: string | null;
} | null;
/** `all`: every post of the wall, when the loader filtered by product */
type MediaResponse = { items?: MediaItem[]; all?: MediaItem[]; wall?: WallInfo };

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
  // "Enter the wall": until the shopper chooses to explore, the wall drifts on its own and
  // scrolling over it scrolls the page. Entering turns on drag/zoom; Exit (or Esc, or
  // scrolling it out of view) hands scrolling back to the page.
  const [entered, setEntered] = React.useState(options.enterToExplore === false);
  const idleRef = React.useRef(!entered);
  idleRef.current = !entered;
  // The wall's submission limit is reached → no "Share yours" button
  const [wallFull, setWallFull] = React.useState(false);
  // Theme editor + no approved posts yet → sample posts, so the merchant sees the wall
  const [isSample, setIsSample] = React.useState(false);
  // Theme editor: a wall with some posts, but fewer than shoppers need to see it
  const [belowNote, setBelowNote] = React.useState<number | null>(null);

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
      .then(async (data) => {
        if (!alive) return;
        setWallFull(data.wall?.spotsLeft === 0);
        // Older cached lists don't carry each post's wall — fall back to this block's wall
        const tag = (list: MediaItem[]) => list.map((i) => (i.wall || !options.wall ? i : { ...i, wall: options.wall }));
        let items = tag(data.items ?? []);
        const min = options.minPosts ?? 0;
        // "This product only": too few posts of this product → show the whole wall instead
        if (options.product && items.length < Math.max(min, 1)) {
          const all = data.all ?? (await fetchMedia({ ...options, product: undefined }).then((d) => d.items).catch(() => undefined));
          if (!alive) return;
          if (all && all.length > items.length) items = tag(all);
        }
        if (!items.length && options.designMode) {
          const samples = samplePosts();
          if (samples.length) {
            setIsSample(true);
            setState({ status: "ready", media: samples });
            return;
          }
        }
        setIsSample(false);
        if (min > 0 && items.length < min) {
          if (options.designMode) {
            setBelowNote(min); // the merchant still sees the real posts, with a note
          } else {
            setState({ status: "below", wall: data.wall ?? null });
            return;
          }
        } else {
          setBelowNote(null);
        }
        setState({ status: "ready", media: items });
        if (!options.designMode) void syncViewsToCart();
      })
      .catch((err) => alive && setState({ status: "error", message: String(err?.message || err) }));
    return () => {
      alive = false;
    };
  }, [options.endpoint, options.campaigns, options.wall, options.product, options.media]);

  // ── center text: fades out while the shopper drags or zooms, back when they stop ──
  const hasCenter = !!(options.centerHeading?.trim() || options.centerSubtext?.trim());
  const [moving, setMoving] = React.useState(false);
  React.useEffect(() => {
    if (!hasCenter) return;
    let timer = 0;
    let down = false;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMoving(false), 1200);
    };
    const onDown = () => { down = true; window.clearTimeout(timer); setMoving(true); };
    const onUp = () => { if (down) { down = false; settle(); } };
    const onWheel = () => { setMoving(true); settle(); };
    root.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    root.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      root.removeEventListener("wheel", onWheel);
    };
  }, [hasCenter, root]);

  // ── below the minimum: shrink to a banner, or hide the block entirely ──
  const hideBlock = state.status === "below" && (options.belowMin === "hide" || !options.share || !options.shareUrl || wallFull || state.wall?.spotsLeft === 0);
  React.useEffect(() => {
    const banner = state.status === "below" && !hideBlock;
    root.classList.toggle("ugme-canvas--banner", banner);
    if (hideBlock) root.style.setProperty("display", "none", "important");
    else root.style.removeProperty("display");
    return () => {
      root.classList.remove("ugme-canvas--banner");
      root.style.removeProperty("display");
    };
  }, [state.status, hideBlock, root]);

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
      if (!k || pausedRef.current || idleRef.current) return;
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

  // ── entering / leaving the wall ──
  React.useEffect(() => {
    root.classList.toggle("ugme-canvas--idle", !entered);
    if (!entered) {
      keysRef.current.clear();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pausedRef.current && !full) setEntered(false);
    };
    window.addEventListener("keydown", onKey);
    // Scrolled (mostly) out of view → back to page scrolling
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window && !full) {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((en) => en.intersectionRatio < 0.25) && !pausedRef.current) setEntered(false);
        },
        { threshold: [0, 0.25] },
      );
      io.observe(root);
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      io?.disconnect();
    };
  }, [entered, full, root]);

  // Entering the wall opens it full screen; leaving closes full screen too.
  // The wall grows out of (and shrinks back into) its spot on the page.
  const gated = options.enterToExplore !== false;
  const placeholderRef = React.useRef<HTMLDivElement | null>(null);
  const closeAnimRef = React.useRef<Animation | null>(null);
  const leave = React.useCallback(() => {
    if (closeAnimRef.current) return; // already closing
    const finish = () => {
      setFull(false);
      if (gated) setEntered(false);
    };
    const ph = placeholderRef.current;
    if (!ph || prefersReducedMotion() || typeof root.animate !== "function") return finish();
    const anim = root.animate([{ clipPath: "inset(0px 0px 0px 0px round 0px)" }, { clipPath: insetFor(ph.getBoundingClientRect()) }], {
      duration: 380,
      easing: "cubic-bezier(.4,0,.2,1)",
      fill: "forwards",
    });
    closeAnimRef.current = anim;
    anim.onfinish = finish;
  }, [gated, root]);
  const leaveRef = React.useRef(leave);
  leaveRef.current = leave;
  const [fsNote, setFsNote] = React.useState(false);

  const enter = React.useCallback(() => {
    setEntered(true);
    setFull(true);
    try {
      root.focus({ preventScroll: true });
    } catch {
      /* older browsers */
    }
  }, [root]);

  // ── fullscreen ──
  React.useEffect(() => {
    if (!full) return;
    const rect = root.getBoundingClientRect();
    // Hold the wall's space on the page so nothing jumps while it's full screen
    const ph = document.createElement("div");
    ph.setAttribute("aria-hidden", "true");
    // (themes like Dawn hide empty divs, so force it visible)
    ph.style.setProperty("display", "block", "important");
    ph.style.height = `${rect.height}px`;
    root.parentNode?.insertBefore(ph, root);
    placeholderRef.current = ph;
    root.classList.add("ugme-canvas--full");
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    if (!prefersReducedMotion() && typeof root.animate === "function") {
      root.animate([{ clipPath: insetFor(rect) }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], {
        duration: 480,
        easing: "cubic-bezier(.22,.8,.24,1)",
      });
    }
    setFsNote(true);
    const noteTimer = window.setTimeout(() => setFsNote(false), 4500);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !pausedRef.current && leaveRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(noteTimer);
      setFsNote(false);
      closeAnimRef.current?.cancel();
      closeAnimRef.current = null;
      root.classList.remove("ugme-canvas--full");
      ph.remove();
      placeholderRef.current = null;
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
      idleRef,
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
      {state.status === "below" && !hideBlock && (
        <div className="ugme-banner">
          <div className="ugme-banner__text">
            {(() => {
              const product = options.productTitle || state.wall?.productTitle;
              const word = state.wall?.contentWord || "photo or video";
              const body = options.bannerText?.trim()
                || (state.wall?.offer ? `Share a ${word} and get ${state.wall.offer}.` : `Share a ${word} and get featured here.`);
              return (
                <>
                  <b>{product ? `Bought ${product}?` : "Bought from us?"}</b>
                  <span>{body}</span>
                </>
              );
            })()}
          </div>
          <a className="ugme-empty__cta" href={options.shareUrl}>
            <ShareIcon />
            <span>{options.shareLabel || "Get featured"}</span>
          </a>
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
                <span>{options.shareLabel || "Get featured"}</span>
              </a>
            )}
          </div>
        </div>
      )}

      {state.status === "ready" && state.media.length > 0 && revealed && hasCenter && entered && (
        <div
          className={`ugme-center${options.centerBackdrop !== false ? " ugme-center--backdrop" : ""}${moving || selected ? " ugme-center--hidden" : ""}`}
          style={options.centerColor ? { color: options.centerColor } : undefined}
          aria-hidden={moving ? true : undefined}
        >
          {options.centerHeading?.trim() && <h2 className="ugme-center__heading">{options.centerHeading.trim()}</h2>}
          {options.centerSubtext?.trim() && <p className="ugme-center__sub">{options.centerSubtext.trim()}</p>}
        </div>
      )}

      {state.status === "ready" && state.media.length > 0 && revealed && (
        <>
          {isSample || belowNote ? (
            <div className="ugme-canvas__chip ugme-canvas__chip--sample">
              {isSample
                ? "Sample posts · only you see these, in the theme editor"
                : `Shoppers see a banner instead until this wall has ${belowNote} posts`}
            </div>
          ) : (
            entered &&
            options.showHint !== false && (
              <div className={`ugme-canvas__chip${hintVisible ? "" : " ugme-canvas__chip--hidden"}`}>{hint}</div>
            )
          )}
          {!entered && (
            // The whole wall is the button; scrolling over it still scrolls the page
            // Center text (if any) sits above the button, so the two read as one invitation
            <button type="button" className="ugme-enter" onClick={enter} aria-label="Enter the social wall">
              {hasCenter && (
                <span
                  className={`ugme-center ugme-center--static${options.centerBackdrop !== false ? " ugme-center--backdrop" : ""}`}
                  style={options.centerColor ? { color: options.centerColor } : undefined}
                >
                  {options.centerHeading?.trim() && <span className="ugme-center__heading">{options.centerHeading.trim()}</span>}
                  {options.centerSubtext?.trim() && <span className="ugme-center__sub">{options.centerSubtext.trim()}</span>}
                </span>
              )}
              <span className="ugme-enter__pill">
                Enter the social wall
                <ArrowIcon />
              </span>
            </button>
          )}
          {full && (
            <>
              <div className={`ugme-canvas__fsnote${fsNote ? "" : " ugme-canvas__fsnote--hidden"}`} role="status">
                You’re in full screen · click <b>Exit</b> or press <b>Esc</b> to leave
              </div>
              <button type="button" className="ugme-canvas__exit" onClick={leave}>
                <CloseIcon />
                <span>Exit full screen</span>
              </button>
            </>
          )}
          {options.share && options.shareUrl && !wallFull && (
            <a className="ugme-canvas__share" href={options.shareUrl}>
              <ShareIcon />
              <span>{options.shareLabel || "Get featured"}</span>
            </a>
          )}
        </>
      )}

      {selected && <MediaOverlay selected={selected} onClose={close} showProducts={options.showProducts !== false} />}
    </>
  );
}
