import type * as THREE from "three";

/** One piece of approved UGME content, as returned by /apps/ugme/canvas */
export type MediaItem = {
  id: string;
  /** Wall campaign the post belongs to (sales attribution) */
  wall?: string;
  type: "image" | "video";
  /** Full image URL (photos) or playable video URL (videos) */
  src: string;
  /** Poster / thumbnail URL. Optional — for videos without one, a poster is grabbed client-side. */
  thumb?: string | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
  /** First name ("Sam") when the buyer opted in to showing their name */
  author?: string | null;
  /** Posts come from verified buyers */
  verified?: boolean;
  /** Products the buyer purchased — shown as product cards in the viewer */
  products?: ProductRef[];
};

export type ProductRef = { id: string; title: string; handle: string | null; imageUrl: string | null };

export type CanvasOptions = {
  /** JSON endpoint, normally the app proxy: /apps/ugme/canvas */
  endpoint?: string;
  /** Campaign IDs to include; empty = all active campaigns for the shop (legacy) */
  campaigns?: string[];
  /** Wall campaign shown by this block */
  wall?: string;
  /** Product page filter: only posts of this product (numeric id or GID) */
  product?: string;
  /** "Share yours" button */
  share?: boolean;
  shareLabel?: string;
  shareUrl?: string;
  /** Product cards in the viewer */
  showProducts?: boolean;
  /** Pass media directly instead of fetching (local playground, admin preview) */
  media?: MediaItem[];
  background?: string;
  showHint?: boolean;
  /** Theme editor — show friendlier empty states */
  designMode?: boolean;
};

export type ChunkData = { key: string; cx: number; cy: number; cz: number };

export type PlaneData = {
  id: string;
  position: THREE.Vector3;
  scale: THREE.Vector3;
  mediaIndex: number;
};

export type SelectedMedia = {
  item: MediaItem;
  /** Screen point (viewport px) the tap happened at — overlay animates from here */
  origin: { x: number; y: number };
  video: HTMLVideoElement | null;
  poster: string | null;
};
