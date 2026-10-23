import { mount } from "../src/mount";
import type { MediaItem } from "../src/types";

const photos: MediaItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i + 1}`,
  type: "image",
  src: `/sample/photo-${i + 1}.jpg`,
  caption: `Sample photo ${i + 1}`,
}));

// video-1/2 ship a thumbnail; video-3/4 don't, so their posters are grabbed client-side.
const videos: MediaItem[] = [1, 2, 3, 4].map((n) => ({
  id: `v${n}`,
  type: "video",
  src: `/sample/video-${n}.mp4`,
  thumb: n <= 2 ? `/sample/video-${n}.jpg` : null,
  caption: `Sample video ${n}`,
}));

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint");
const el = document.getElementById("canvas")!;
mount(el, endpoint ? { endpoint, campaigns: (params.get("campaigns") || "").split(",").filter(Boolean) } : { media: [...photos, ...videos] });
