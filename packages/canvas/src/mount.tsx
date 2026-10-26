/**
 * Entry point for the storefront bundle (window.UgmeCanvas).
 *
 *   UgmeCanvas.mount(el, options?) → unmount()
 *
 * Options default to the element's data attributes, which the theme block sets:
 *   data-endpoint="/apps/social-wall/canvas"  data-wall="<wall campaign id>"  data-product="123"
 *   data-share="true" data-share-label="Share yours" data-share-url="…"  data-show-products="true"
 *   data-background="#ffffff"  data-show-hint="true"  data-design-mode="true"
 */
import { createRoot } from "react-dom/client";
import { UgmeCanvasApp } from "./app";
import { injectStyles } from "./styles";
import type { CanvasOptions } from "./types";

export type { CanvasOptions, MediaItem } from "./types";

function optionsFromDataset(el: HTMLElement): CanvasOptions {
  const d = el.dataset;
  return {
    endpoint: d.endpoint || "/apps/social-wall/canvas",
    campaigns: (d.campaigns || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    wall: d.wall || undefined,
    product: d.product || undefined,
    share: d.share !== "false" && !!d.shareUrl,
    shareLabel: d.shareLabel || "Share yours",
    shareUrl: d.shareUrl || undefined,
    showProducts: d.showProducts !== "false",
    background: d.background || undefined,
    showHint: d.showHint !== "false",
    designMode: d.designMode === "true",
  };
}

const mounted = new WeakMap<HTMLElement, () => void>();

export function mount(el: HTMLElement, options: CanvasOptions = {}): () => void {
  mounted.get(el)?.();
  injectStyles();
  const opts = { ...optionsFromDataset(el), ...options };
  el.classList.add("ugme-canvas");
  if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
  if (opts.background) el.style.setProperty("--ugme-canvas-bg", opts.background);
  const root = createRoot(el);
  root.render(<UgmeCanvasApp options={opts} root={el} />);
  const unmount = () => {
    mounted.delete(el);
    root.unmount();
    el.classList.remove("ugme-canvas", "ugme-canvas--full");
  };
  mounted.set(el, unmount);
  return unmount;
}
