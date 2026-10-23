// Layout + math helpers adapted from edoardolunardi/infinite-canvas (MIT).
import * as THREE from "three";
import type { PlaneData } from "./types";

export const CHUNK_SIZE = 110;
export const RENDER_DISTANCE = 2;
export const CHUNK_FADE_MARGIN = 1;
export const MAX_VELOCITY = 3.2;
export const DEPTH_FADE_START = 140;
export const DEPTH_FADE_END = 260;
export const INVIS_THRESHOLD = 0.01;
export const KEYBOARD_SPEED = 0.18;
export const VELOCITY_LERP = 0.16;
export const VELOCITY_DECAY = 0.9;
export const INITIAL_CAMERA_Z = 50;
export const ITEMS_PER_CHUNK = 5;

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const seededRandom = (seed: number) => {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
};

const hashString = (str: string) => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
};

export type ChunkOffset = { dx: number; dy: number; dz: number; dist: number };

export const CHUNK_OFFSETS: ChunkOffset[] = (() => {
  const maxDist = RENDER_DISTANCE + CHUNK_FADE_MARGIN;
  const offsets: ChunkOffset[] = [];
  for (let dx = -maxDist; dx <= maxDist; dx++)
    for (let dy = -maxDist; dy <= maxDist; dy++)
      for (let dz = -maxDist; dz <= maxDist; dz++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
        if (dist <= maxDist) offsets.push({ dx, dy, dz, dist });
      }
  return offsets;
})();

const MAX_PLANE_CACHE = 256;
const planeCache = new Map<string, PlaneData[]>();

const generateChunkPlanes = (cx: number, cy: number, cz: number): PlaneData[] => {
  const planes: PlaneData[] = [];
  const seed = hashString(`${cx},${cy},${cz}`);
  for (let i = 0; i < ITEMS_PER_CHUNK; i++) {
    const s = seed + i * 1000;
    const r = (n: number) => seededRandom(s + n);
    const size = 12 + r(4) * 8;
    planes.push({
      id: `${cx}-${cy}-${cz}-${i}`,
      position: new THREE.Vector3(
        cx * CHUNK_SIZE + r(0) * CHUNK_SIZE,
        cy * CHUNK_SIZE + r(1) * CHUNK_SIZE,
        cz * CHUNK_SIZE + r(2) * CHUNK_SIZE,
      ),
      scale: new THREE.Vector3(size, size, 1),
      mediaIndex: Math.floor(r(5) * 1_000_000),
    });
  }
  return planes;
};

export const generateChunkPlanesCached = (cx: number, cy: number, cz: number) => {
  const key = `${cx},${cy},${cz}`;
  const cached = planeCache.get(key);
  if (cached) {
    planeCache.delete(key);
    planeCache.set(key, cached);
    return cached;
  }
  const planes = generateChunkPlanes(cx, cy, cz);
  planeCache.set(key, planes);
  while (planeCache.size > MAX_PLANE_CACHE) {
    const first = planeCache.keys().next().value as string | undefined;
    if (!first) break;
    planeCache.delete(first);
  }
  return planes;
};

export const getChunkUpdateThrottleMs = (isZooming: boolean, zoomSpeed: number) =>
  zoomSpeed > 1.0 ? 500 : isZooming ? 400 : 100;

export const isTouchDevice = () =>
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0 || !!window.matchMedia?.("(pointer: coarse)").matches);
