/**
 * One-off (safe to re-run): copy every APPROVED submission's media into the
 * bucket's public/ folder and write each wall campaign's list to
 * public/walls/<id>.json. Run after setting MEDIA_PUBLIC_BASE_URL.
 *
 *   npm run media:publish            # all shops
 *   npm run media:publish -- --dry-run
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
(globalThis as any).prismaGlobal = prisma;
const dryRun = process.argv.includes("--dry-run");
const { publicMediaBase, publishSubmissionMedia, rebuildWallJson } = await import("../app/utils/public-media.server");

if (!publicMediaBase()) {
  console.error("MEDIA_PUBLIC_BASE_URL isn't set (e.g. https://media.cloverkitstudio.com) — nothing to do.");
  process.exit(1);
}

const approved = await prisma.submission.findMany({
  where: { status: "APPROVED", rightsAccepted: true },
  select: { id: true, contentUrl: true, thumbnailUrl: true, campaignId: true },
});
console.log(`${approved.length} approved submission(s) to publish${dryRun ? " (dry run)" : ""}`);
let ok = 0;
for (const s of approved) {
  if (dryRun) continue;
  try {
    await publishSubmissionMedia(s);
    ok++;
  } catch (err) {
    console.log(`  ✗ ${s.id}: ${(err as Error).message}`);
  }
}
const walls = await prisma.campaign.findMany({ select: { id: true, title: true } });
for (const w of walls) {
  if (dryRun) continue;
  await rebuildWallJson(w.id).catch((err) => console.log(`  ✗ wall ${w.title}: ${(err as Error).message}`));
}
console.log(dryRun ? `Would publish ${approved.length} submission(s) and ${walls.length} wall list(s).` : `Published ${ok}/${approved.length} submission(s), wrote ${walls.length} wall list(s).`);
await prisma.$disconnect();
