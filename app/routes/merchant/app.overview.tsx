import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { overviewData } from "../../utils/overview.server";
import { Overview } from "../../components/Overview";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, select: { id: true, shopDomain: true, planTier: true } });
  if (!shop) return redirect("/app");
  return json(await overviewData(admin.graphql, shop));
};

export default function OverviewPage() {
  return <Overview {...useLoaderData<typeof loader>()} />;
}
