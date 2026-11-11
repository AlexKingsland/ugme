/**
 * The real storefront wall, running in the admin with sample photos. Loads the same
 * bundle the theme block uses (copied to /demo-wall/ugme-canvas.js), so what the
 * merchant explores here is exactly what shoppers get.
 */
import { useEffect, useRef, useState } from "react";
import { demoPosts, type DemoTheme } from "../utils/demo-wall";

declare global {
  interface Window {
    UgmeCanvas?: { mount: (el: HTMLElement, options?: Record<string, unknown>) => () => void };
  }
}

let bundle: Promise<void> | null = null;
function loadBundle() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.UgmeCanvas) return Promise.resolve();
  bundle ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/demo-wall/ugme-canvas.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      bundle = null;
      reject(new Error("wall bundle failed to load"));
    };
    document.head.appendChild(s);
  });
  return bundle;
}

export function DemoWall({
  theme,
  heading,
  subtext,
  height = 560,
  showHint = true,
}: {
  theme: DemoTheme;
  heading?: string;
  subtext?: string;
  height?: number | string;
  showHint?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Typing in the heading fields shouldn't rebuild the wall on every key
  const [text, setText] = useState({ heading, subtext });
  useEffect(() => {
    const t = setTimeout(() => setText({ heading, subtext }), 350);
    return () => clearTimeout(t);
  }, [heading, subtext]);

  useEffect(() => {
    let unmount: (() => void) | null = null;
    let alive = true;
    loadBundle()
      .then(() => {
        if (!alive || !el.current || !window.UgmeCanvas) return;
        unmount = window.UgmeCanvas.mount(el.current, {
          media: demoPosts(theme),
          background: "#f6f6f3",
          share: false,
          showProducts: false,
          showHint,
          centerHeading: text.heading || "",
          centerSubtext: text.subtext || "",
          centerColor: "#111111",
          centerBackdrop: true,
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      unmount?.();
    };
  }, [theme, text, showHint]);

  if (failed) {
    return (
      <div style={{ height, display: "grid", placeItems: "center", background: "#f6f6f3", borderRadius: 12, color: "#616161" }}>
        Couldn't load the example wall. Refresh to try again.
      </div>
    );
  }
  return <div ref={el} style={{ height, minHeight: 0, borderRadius: 12, overflow: "hidden", ["--ugme-canvas-height" as string]: typeof height === "number" ? `${height}px` : height }} />;
}
