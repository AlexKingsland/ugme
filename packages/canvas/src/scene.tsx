// Scene adapted from edoardolunardi/infinite-canvas (MIT) for UGME:
// - textures come from media-loader (downscaled thumbnails, video posters)
// - tap/click detection that ignores drags, raycast to find the tapped item
// - hover / rest-near-centre video prefetch
// - pointer coords relative to the embed (not the window), keyboard only when focused
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as React from "react";
import * as THREE from "three";
import { getMedia, rememberLoaded } from "./media-loader";
import type { ChunkData, MediaItem, PlaneData } from "./types";
import {
  CHUNK_FADE_MARGIN,
  CHUNK_OFFSETS,
  CHUNK_SIZE,
  DEPTH_FADE_END,
  DEPTH_FADE_START,
  INITIAL_CAMERA_Z,
  INVIS_THRESHOLD,
  KEYBOARD_SPEED,
  MAX_VELOCITY,
  RENDER_DISTANCE,
  VELOCITY_DECAY,
  VELOCITY_LERP,
  clamp,
  generateChunkPlanesCached,
  getChunkUpdateThrottleMs,
  isTouchDevice,
  lerp,
} from "./utils";

const PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);
const TAP_MAX_MOVE_PX = 8;
const TAP_MAX_MS = 600;

type CameraGridState = { cx: number; cy: number; cz: number; camZ: number };

export type SceneHandlers = {
  onSelect: (item: MediaItem, origin: { x: number; y: number }) => void;
  onPrefetch: (item: MediaItem) => void;
  onFirstInteraction: () => void;
  pausedRef: React.RefObject<boolean>;
  keysRef: React.RefObject<Set<string>>;
};

// ── Plane ───────────────────────────────────────────────────────

function MediaPlane({
  position,
  scale,
  media,
  chunkCx,
  chunkCy,
  chunkCz,
  cameraGridRef,
}: {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  media: MediaItem;
  chunkCx: number;
  chunkCy: number;
  chunkCz: number;
  cameraGridRef: React.RefObject<CameraGridState>;
}) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const materialRef = React.useRef<THREE.MeshBasicMaterial>(null);
  const local = React.useRef({ opacity: 0, frame: 0 });
  const [loaded, setLoaded] = React.useState<{ texture: THREE.Texture; aspect: number } | null>(null);

  React.useEffect(() => {
    let alive = true;
    getMedia(media).then((m) => {
      rememberLoaded(media, m);
      if (alive) setLoaded({ texture: m.texture, aspect: m.aspect });
    });
    return () => {
      alive = false;
    };
  }, [media]);

  const displayScale = React.useMemo(() => {
    const aspect = media.width && media.height ? media.width / media.height : (loaded?.aspect ?? 1);
    return new THREE.Vector3(scale.y * aspect, scale.y, 1);
  }, [media.width, media.height, loaded, scale]);

  useFrame(() => {
    const material = materialRef.current;
    const mesh = meshRef.current;
    const s = local.current;
    if (!material || !mesh) return;

    s.frame = (s.frame + 1) & 1;
    if (s.opacity < INVIS_THRESHOLD && !mesh.visible && s.frame === 0) return;

    const cam = cameraGridRef.current;
    const dist = Math.max(Math.abs(chunkCx - cam.cx), Math.abs(chunkCy - cam.cy), Math.abs(chunkCz - cam.cz));
    const absDepth = Math.abs(position.z - cam.camZ);

    if (absDepth > DEPTH_FADE_END + 50) {
      s.opacity = 0;
      material.opacity = 0;
      material.depthWrite = false;
      mesh.visible = false;
      return;
    }

    const gridFade =
      dist <= RENDER_DISTANCE ? 1 : Math.max(0, 1 - (dist - RENDER_DISTANCE) / Math.max(CHUNK_FADE_MARGIN, 0.0001));
    const depthFade =
      absDepth <= DEPTH_FADE_START
        ? 1
        : Math.max(0, 1 - (absDepth - DEPTH_FADE_START) / Math.max(DEPTH_FADE_END - DEPTH_FADE_START, 0.0001));
    const target = Math.min(gridFade, depthFade * depthFade);

    s.opacity = target < INVIS_THRESHOLD && s.opacity < INVIS_THRESHOLD ? 0 : lerp(s.opacity, target, 0.18);
    const opaque = s.opacity > 0.99;
    material.opacity = opaque ? 1 : s.opacity;
    material.depthWrite = opaque;
    mesh.visible = s.opacity > INVIS_THRESHOLD;
  });

  if (!loaded) return null;

  return (
    <mesh
      ref={meshRef}
      position={position}
      scale={displayScale}
      visible={false}
      geometry={PLANE_GEOMETRY}
      userData={{ ugmeItem: media }}
    >
      <meshBasicMaterial
        ref={materialRef}
        map={loaded.texture}
        transparent
        opacity={0}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function Chunk({
  cx,
  cy,
  cz,
  media,
  cameraGridRef,
}: {
  cx: number;
  cy: number;
  cz: number;
  media: MediaItem[];
  cameraGridRef: React.RefObject<CameraGridState>;
}) {
  const [planes, setPlanes] = React.useState<PlaneData[] | null>(null);

  React.useEffect(() => {
    let canceled = false;
    const run = () => !canceled && setPlanes(generateChunkPlanesCached(cx, cy, cz));
    if (typeof requestIdleCallback !== "undefined") {
      const id = requestIdleCallback(run, { timeout: 100 });
      return () => {
        canceled = true;
        cancelIdleCallback(id);
      };
    }
    const id = setTimeout(run, 0);
    return () => {
      canceled = true;
      clearTimeout(id);
    };
  }, [cx, cy, cz]);

  if (!planes) return null;

  return (
    <group>
      {planes.map((plane) => {
        const item = media[plane.mediaIndex % media.length];
        if (!item) return null;
        return (
          <MediaPlane
            key={plane.id}
            position={plane.position}
            scale={plane.scale}
            media={item}
            chunkCx={cx}
            chunkCy={cy}
            chunkCz={cz}
            cameraGridRef={cameraGridRef}
          />
        );
      })}
    </group>
  );
}

// ── Controller ──────────────────────────────────────────────────

type ControllerState = {
  velocity: { x: number; y: number; z: number };
  targetVel: { x: number; y: number; z: number };
  basePos: { x: number; y: number; z: number };
  drift: { x: number; y: number };
  mouse: { x: number; y: number };
  lastMouse: { x: number; y: number };
  scrollAccum: number;
  isDragging: boolean;
  lastTouches: Touch[];
  lastTouchDist: number;
  lastChunkKey: string;
  lastChunkUpdate: number;
  pendingChunk: { cx: number; cy: number; cz: number } | null;
  tapStart: { x: number; y: number; t: number; moved: number } | null;
  lastHoverCheck: number;
  restFrames: number;
};

const touchDistance = (t: Touch[]) =>
  t.length < 2 ? 0 : Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

function SceneController({ media, handlers }: { media: MediaItem[]; handlers: SceneHandlers }) {
  const { camera, gl, scene, raycaster } = useThree();
  const touch = React.useMemo(isTouchDevice, []);
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  const state = React.useRef<ControllerState>({
    velocity: { x: 0, y: 0, z: 0 },
    targetVel: { x: 0, y: 0, z: 0 },
    basePos: { x: 0, y: 0, z: INITIAL_CAMERA_Z },
    drift: { x: 0, y: 0 },
    mouse: { x: 0, y: 0 },
    lastMouse: { x: 0, y: 0 },
    scrollAccum: 0,
    isDragging: false,
    lastTouches: [],
    lastTouchDist: 0,
    lastChunkKey: "",
    lastChunkUpdate: 0,
    pendingChunk: null,
    tapStart: null,
    lastHoverCheck: 0,
    restFrames: 0,
  });
  const cameraGridRef = React.useRef<CameraGridState>({ cx: 0, cy: 0, cz: 0, camZ: camera.position.z });
  const [chunks, setChunks] = React.useState<ChunkData[]>([]);

  /** Raycast at a viewport point; returns the front-most visible media item. */
  const pick = React.useCallback(
    (clientX: number, clientY: number): MediaItem | null => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(scene.children, true);
      for (const h of hits) {
        const obj = h.object as THREE.Mesh;
        const mat = obj.material as THREE.MeshBasicMaterial | undefined;
        const item = obj.userData?.ugmeItem as MediaItem | undefined;
        if (item && obj.visible && (mat?.opacity ?? 0) > 0.35) return item;
      }
      return null;
    },
    [camera, gl, raycaster, scene],
  );

  React.useEffect(() => {
    const canvas = gl.domElement;
    const s = state.current;
    canvas.style.cursor = "grab";
    const paused = () => handlersRef.current.pausedRef.current;
    let interacted = false;
    const interact = () => {
      if (!interacted) {
        interacted = true;
        handlersRef.current.onFirstInteraction();
      }
    };

    // Tap detection via pointer events (fire on touch even though touch* defaults are prevented)
    const onPointerDown = (e: PointerEvent) => {
      if (paused()) return;
      s.tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    };
    const onPointerMoveTap = (e: PointerEvent) => {
      if (s.tapStart) s.tapStart.moved = Math.max(s.tapStart.moved, Math.hypot(e.clientX - s.tapStart.x, e.clientY - s.tapStart.y));
    };
    const onPointerUp = (e: PointerEvent) => {
      const start = s.tapStart;
      s.tapStart = null;
      if (!start || paused()) return;
      if (start.moved > TAP_MAX_MOVE_PX || performance.now() - start.t > TAP_MAX_MS) return;
      const item = pick(e.clientX, e.clientY);
      if (item) {
        // Kill momentum so the scene doesn't drift behind the overlay
        s.targetVel = { x: 0, y: 0, z: 0 };
        s.velocity = { x: 0, y: 0, z: 0 };
        s.isDragging = false;
        // Called synchronously inside the pointerup gesture → play() with sound is allowed
        handlersRef.current.onSelect(item, { x: e.clientX, y: e.clientY });
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (paused()) return;
      interact();
      s.isDragging = true;
      s.lastMouse = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = "grabbing";
    };
    const onMouseUp = () => {
      s.isDragging = false;
      canvas.style.cursor = "grab";
    };
    const onMouseLeave = () => {
      s.mouse = { x: 0, y: 0 };
      s.isDragging = false;
      canvas.style.cursor = "grab";
    };
    const onMouseMove = (e: MouseEvent) => {
      if (paused()) return;
      const rect = canvas.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (inside) {
        s.mouse = {
          x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
          y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
        };
      }
      if (s.isDragging) {
        s.targetVel.x -= (e.clientX - s.lastMouse.x) * 0.025;
        s.targetVel.y += (e.clientY - s.lastMouse.y) * 0.025;
        s.lastMouse = { x: e.clientX, y: e.clientY };
      } else if (inside && !touch) {
        // Hover → warm the video so a click plays instantly
        const now = performance.now();
        if (now - s.lastHoverCheck > 120) {
          s.lastHoverCheck = now;
          const item = pick(e.clientX, e.clientY);
          canvas.style.cursor = item ? "pointer" : "grab";
          if (item?.type === "video") handlersRef.current.onPrefetch(item);
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (paused()) return;
      e.preventDefault();
      interact();
      s.scrollAccum += e.deltaY * 0.006;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (paused()) return;
      e.preventDefault();
      interact();
      s.lastTouches = Array.from(e.touches);
      s.lastTouchDist = touchDistance(s.lastTouches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (paused()) return;
      e.preventDefault();
      const touches = Array.from(e.touches);
      if (touches.length === 1 && s.lastTouches.length >= 1) {
        const [t] = touches;
        const [last] = s.lastTouches;
        if (t && last) {
          s.targetVel.x -= (t.clientX - last.clientX) * 0.02;
          s.targetVel.y += (t.clientY - last.clientY) * 0.02;
        }
      } else if (touches.length === 2 && s.lastTouchDist > 0) {
        const d = touchDistance(touches);
        s.scrollAccum += (s.lastTouchDist - d) * 0.006;
        s.lastTouchDist = d;
      }
      s.lastTouches = touches;
    };
    const onTouchEnd = (e: TouchEvent) => {
      s.lastTouches = Array.from(e.touches);
      s.lastTouchDist = touchDistance(s.lastTouches);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMoveTap);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseleave", onMouseLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMoveTap);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, [gl, pick, touch]);

  useFrame(() => {
    const s = state.current;
    const now = performance.now();
    const paused = handlersRef.current.pausedRef.current;

    if (!paused) {
      const keys = handlersRef.current.keysRef.current;
      if (keys.size) {
        if (keys.has("forward")) s.targetVel.z -= KEYBOARD_SPEED;
        if (keys.has("backward")) s.targetVel.z += KEYBOARD_SPEED;
        if (keys.has("left")) s.targetVel.x -= KEYBOARD_SPEED;
        if (keys.has("right")) s.targetVel.x += KEYBOARD_SPEED;
        if (keys.has("down")) s.targetVel.y -= KEYBOARD_SPEED;
        if (keys.has("up")) s.targetVel.y += KEYBOARD_SPEED;
      }
    }

    const isZooming = Math.abs(s.velocity.z) > 0.05;
    const zoomFactor = clamp(s.basePos.z / 50, 0.3, 2.0);
    const driftAmount = 8.0 * zoomFactor;
    const driftLerp = isZooming ? 0.2 : 0.12;

    if (s.isDragging || paused) {
      // freeze drift
    } else if (touch) {
      s.drift.x = lerp(s.drift.x, 0, driftLerp);
      s.drift.y = lerp(s.drift.y, 0, driftLerp);
    } else {
      s.drift.x = lerp(s.drift.x, s.mouse.x * driftAmount, driftLerp);
      s.drift.y = lerp(s.drift.y, s.mouse.y * driftAmount, driftLerp);
    }

    s.targetVel.z += s.scrollAccum;
    s.scrollAccum *= 0.8;

    s.targetVel.x = clamp(s.targetVel.x, -MAX_VELOCITY, MAX_VELOCITY);
    s.targetVel.y = clamp(s.targetVel.y, -MAX_VELOCITY, MAX_VELOCITY);
    s.targetVel.z = clamp(s.targetVel.z, -MAX_VELOCITY, MAX_VELOCITY);

    s.velocity.x = lerp(s.velocity.x, s.targetVel.x, VELOCITY_LERP);
    s.velocity.y = lerp(s.velocity.y, s.targetVel.y, VELOCITY_LERP);
    s.velocity.z = lerp(s.velocity.z, s.targetVel.z, VELOCITY_LERP);

    s.basePos.x += s.velocity.x;
    s.basePos.y += s.velocity.y;
    s.basePos.z += s.velocity.z;

    camera.position.set(s.basePos.x + s.drift.x, s.basePos.y + s.drift.y, s.basePos.z);

    s.targetVel.x *= VELOCITY_DECAY;
    s.targetVel.y *= VELOCITY_DECAY;
    s.targetVel.z *= VELOCITY_DECAY;

    // Touch: once the view comes to rest, warm the video nearest the centre
    const speed = Math.abs(s.velocity.x) + Math.abs(s.velocity.y) + Math.abs(s.velocity.z);
    if (touch && !paused) {
      s.restFrames = speed < 0.02 ? s.restFrames + 1 : 0;
      if (s.restFrames === 20) {
        const rect = gl.domElement.getBoundingClientRect();
        const item = pick(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (item?.type === "video") handlersRef.current.onPrefetch(item);
      }
    }

    const cx = Math.floor(s.basePos.x / CHUNK_SIZE);
    const cy = Math.floor(s.basePos.y / CHUNK_SIZE);
    const cz = Math.floor(s.basePos.z / CHUNK_SIZE);
    cameraGridRef.current = { cx, cy, cz, camZ: s.basePos.z };

    const key = `${cx},${cy},${cz}`;
    if (key !== s.lastChunkKey) {
      s.pendingChunk = { cx, cy, cz };
      s.lastChunkKey = key;
    }

    const throttleMs = getChunkUpdateThrottleMs(isZooming, Math.abs(s.velocity.z));
    if (s.pendingChunk && now - s.lastChunkUpdate >= throttleMs) {
      const { cx: ucx, cy: ucy, cz: ucz } = s.pendingChunk;
      s.pendingChunk = null;
      s.lastChunkUpdate = now;
      setChunks(
        CHUNK_OFFSETS.map((o) => ({
          key: `${ucx + o.dx},${ucy + o.dy},${ucz + o.dz}`,
          cx: ucx + o.dx,
          cy: ucy + o.dy,
          cz: ucz + o.dz,
        })),
      );
    }
  });

  React.useEffect(() => {
    const s = state.current;
    s.basePos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    setChunks(CHUNK_OFFSETS.map((o) => ({ key: `${o.dx},${o.dy},${o.dz}`, cx: o.dx, cy: o.dy, cz: o.dz })));
  }, [camera]);

  return (
    <>
      {chunks.map((c) => (
        <Chunk key={c.key} cx={c.cx} cy={c.cy} cz={c.cz} media={media} cameraGridRef={cameraGridRef} />
      ))}
    </>
  );
}

export function InfiniteScene({
  media,
  background,
  handlers,
}: {
  media: MediaItem[];
  background: string;
  handlers: SceneHandlers;
}) {
  // Render at up to 2x pixel density (phones are 3x). The original 1.25x cap on
  // touch made every tile look soft on iPhones.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return (
    <Canvas
      className="ugme-canvas__gl"
      camera={{ position: [0, 0, INITIAL_CAMERA_Z], fov: 60, near: 1, far: 500 }}
      dpr={dpr}
      flat
      gl={{ antialias: false, powerPreference: "high-performance" }}
    >
      <color attach="background" args={[background]} />
      <fog attach="fog" args={[background, 120, 320]} />
      <SceneController media={media} handlers={handlers} />
    </Canvas>
  );
}
