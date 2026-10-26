import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { maybeSyncCampaignMetaobjects } from "../../utils/canvas.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Auto-provision Shop record on first visit
  await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: { accessToken: session.accessToken ?? "" },
    create: {
      shopDomain: session.shop,
      accessToken: session.accessToken ?? "",
    },
  });

  // Keep wall campaigns pickable in the theme editor's Social Wall block (throttled, non-blocking)
  maybeSyncCampaignMetaobjects(admin.graphql, session.shop);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/walls">Wall campaigns</Link>
        <Link to="/app/library">Submissions</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their
// temporary redirects work correctly.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
