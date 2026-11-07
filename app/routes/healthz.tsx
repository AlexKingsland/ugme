import prisma from "../db.server";

/**
 * Render health check: the server is up and can reach the database.
 * Also reports the live commit ("ok abc1234") so `npm run release` knows when
 * Render is running the new code before it deploys the Shopify side.
 */
export const loader = async () => {
  const commit = (process.env.RENDER_GIT_COMMIT || "").slice(0, 12);
  const headers = { "Cache-Control": "no-store", "Content-Type": "text/plain" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return new Response(commit ? `ok ${commit}` : "ok", { status: 200, headers });
  } catch {
    return new Response("database unreachable", { status: 503, headers });
  }
};
