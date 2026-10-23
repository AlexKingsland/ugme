#!/usr/bin/env node
/**
 * One-time setup: the theme block's campaign picker needs the app's numeric ID,
 * because Shopify doesn't resolve "$app:" inside theme block schemas yet.
 *
 *   npm run canvas:set-app-id -- 1234567890
 *
 * Find the ID on the Social Wall page in the UGME admin (dev mode), or in the app's
 * URL in the Shopify Dev Dashboard / Partner Dashboard.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const id = (process.argv[2] || "").trim();
if (!/^\d+$/.test(id)) {
  console.error("Usage: npm run canvas:set-app-id -- <numeric app id>");
  process.exit(1);
}
const file = join(dirname(fileURLToPath(import.meta.url)), "../extensions/ugme-canvas/blocks/ugme-canvas.liquid");
const src = readFileSync(file, "utf8");
const next = src.replace(/"metaobject_type":\s*"app--[^"]*--ugme_campaign"/, `"metaobject_type": "app--${id}--ugme_campaign"`);
if (next === src && !src.includes(`app--${id}--ugme_campaign`)) {
  console.error("Couldn't find the metaobject_type setting in", file);
  process.exit(1);
}
writeFileSync(file, next);
console.log(`✓ Social Wall block now uses metaobject type app--${id}--ugme_campaign`);
