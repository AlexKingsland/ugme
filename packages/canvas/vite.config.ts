import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds a single self-contained IIFE (React 19 + R3F + three bundled in)
// straight into the theme app extension's assets folder. It never shares
// React with the admin app, so there is no React 18/19 conflict.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // public/ holds playground sample media only — never copy it into the extension
  publicDir: command === "build" ? false : "public",
  // ASCII-only output so the bundle renders correctly whatever charset it is served with
  esbuild: { charset: "ascii" },
  define: command === "build" ? { "process.env.NODE_ENV": JSON.stringify("production") } : {},
  build: {
    outDir: resolve(__dirname, "../../extensions/ugme-canvas/assets"),
    emptyOutDir: false,
    sourcemap: false,
    target: "es2020",
    lib: {
      entry: resolve(__dirname, "src/mount.tsx"),
      name: "UgmeCanvas",
      formats: ["iife"],
      fileName: () => "ugme-canvas.js",
    },
  },
}));
