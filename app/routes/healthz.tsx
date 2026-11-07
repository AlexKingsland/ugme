import prisma from "../db.server";

/** Render health check: the server is up and can reach the database. */
export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("database unreachable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
