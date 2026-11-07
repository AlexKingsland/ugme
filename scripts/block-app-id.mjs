#!/usr/bin/env node
/**
 * Writes the Social Wall theme block for one app (dev or production).
 *
 * Shopify's theme block settings need the app-owned metaobject type spelled out:
 *   app--<numeric app id>--ugme_campaign
 * (`$app:` isn't supported there), and the dev app and the production app have
 * different ids. This fills that in from scripts/templates/ugme-canvas.block.liquid.
 *
 *   node scripts/block-app-id.mjs shopify.app.dev.toml   (npm run dev / npm run deploy)
 *   node scripts/block-app-id.mjs shopify.app.toml       (npm run deploy:prod)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// client id → numeric app id (Dev Dashboard URL, or `npm run check:metaobjects`)
const APP_IDS = {
  "79239f951610fa45ab1160d2fe4438f6": "425610215425", // Social Wall (production)
  "2ba8e784637a603cdcf5452050300d9a": "444750266369", // Social Wall (dev)
};

const config = process.argv[2] || "shopify.app.dev.toml";
const clientId = readFileSync(config, "utf8").match(/^client_id\s*=\s*"([^"]+)"/m)?.[1];
const appId = clientId && APP_IDS[clientId];
if (!appId) {
  console.error(`✗ No numeric app id for ${config} (client id ${clientId}). Add it to APP_IDS in scripts/block-app-id.mjs.`);
  process.exit(1);
}
const template = readFileSync("scripts/templates/ugme-canvas.block.liquid", "utf8");
const block = template
  .replace(/^\{%- comment -%\}\n  TEMPLATE[\s\S]*?\{%- endcomment -%\}\n/, "{%- comment -%} Generated from scripts/templates/ugme-canvas.block.liquid — edit that file. {%- endcomment -%}\n")
  .replaceAll("__APP_ID__", appId);
// The folder can be missing on a fresh clone (the generated file isn't in git)
mkdirSync("extensions/ugme-canvas/blocks", { recursive: true });
writeFileSync("extensions/ugme-canvas/blocks/ugme-canvas.liquid", block);
console.log(`✓ theme block set for ${config} (app ${appId})`);
