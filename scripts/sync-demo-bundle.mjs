// Copies the storefront wall bundle into public/ so the admin's example wall
// (/app/demo) runs the exact same wall shoppers see. Runs before dev and build.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public/demo-wall", { recursive: true });
copyFileSync("extensions/ugme-canvas/assets/ugme-canvas.js", "public/demo-wall/ugme-canvas.js");
