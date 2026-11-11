import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, TextField, Badge, InlineGrid } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../../shopify.server";
import { addToThemeUrl } from "../../utils/wall-theme.server";
import { DEMO_THEMES, type DemoTheme } from "../../utils/demo-wall";
import { DemoWall } from "../../components/DemoWall";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return json({ themeUrl: addToThemeUrl(session.shop, process.env.SHOPIFY_API_KEY || "") });
};

export default function DemoWallPage() {
  const { themeUrl } = useLoaderData<typeof loader>();
  const [theme, setTheme] = useState<DemoTheme>("coffee");
  const preset = DEMO_THEMES.find((t) => t.id === theme)!;
  const [heading, setHeading] = useState(preset.heading);
  const [subtext, setSubtext] = useState(preset.subtext);

  const pick = (id: DemoTheme) => {
    const t = DEMO_THEMES.find((x) => x.id === id)!;
    setTheme(id);
    setHeading(t.heading);
    setSubtext(t.subtext);
  };

  return (
    <Page
      title="Example wall"
      subtitle="What a finished Social Wall feels like. Drag to explore, scroll to zoom, click a post."
      backAction={{ content: "Home", url: "/app" }}
      primaryAction={{ content: "Create wall campaign", url: "/app/walls/new" }}
      secondaryActions={[{ content: "Open theme editor", url: themeUrl, target: "_top" }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <InlineStack gap="200">
                  {DEMO_THEMES.map((t) => (
                    <Button key={t.id} pressed={t.id === theme} onClick={() => pick(t.id)}>
                      {t.label}
                    </Button>
                  ))}
                </InlineStack>
                <Badge>Sample photos · only you see this</Badge>
              </InlineStack>
              <DemoWall theme={theme} heading={heading} subtext={subtext} height={560} />
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                <TextField label="Center heading" value={heading} onChange={setHeading} autoComplete="off" maxLength={80} placeholder="Leave blank for none" />
                <TextField label="Center subheading" value={subtext} onChange={setSubtext} autoComplete="off" maxLength={120} />
              </InlineGrid>
              <Text as="p" variant="bodySm" tone="subdued">
                Try your own center text here. On your store, set it in the theme editor: Social Wall block → Center text.
                Your real wall only shows posts you've approved from verified buyers.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
