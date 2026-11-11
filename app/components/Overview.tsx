/**
 * First screen for merchants without a wall campaign yet: what Social Wall does,
 * a peek at a finished wall, and the three setup steps.
 */
import { Link } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, InlineGrid, Text, Button, Badge, Box, Divider } from "@shopify/polaris";
import { demoPosts } from "../utils/demo-wall";

const COLLAGE = [...demoPosts("coffee").slice(0, 4), ...demoPosts("pets").slice(0, 4), ...demoPosts("outdoors").slice(0, 4)];
// Hand-placed tiles: [left %, top %, width %, rotation°]
const SPOTS: [number, number, number, number][] = [
  [2, 6, 26, -4], [30, 0, 22, 3], [55, 8, 24, -2], [80, 2, 20, 4],
  [6, 46, 22, 3], [33, 38, 28, -1], [63, 44, 20, -4], [84, 40, 18, 2],
  [0, 78, 20, -2], [24, 74, 22, 4], [50, 78, 24, -3], [76, 76, 24, 2],
];

const STEPS = [
  { title: "Create a wall campaign", body: "Pick the products, say what you'd like customers to share, and choose a reward." },
  { title: "Add it to your theme", body: "Place the Social Wall block anywhere in your store from the theme editor." },
  { title: "Approve the best posts", body: "Verified buyers share. You approve, they get rewarded, and the post goes live." },
];

type Steps = { wall: boolean; theme: boolean; posts: boolean };

export function Overview({ themeUrl, planName, planLine, steps, firstWallId }: { themeUrl: string; planName: string; planLine: string; steps: Steps; firstWallId: string | null }) {
  const done = [steps.wall, steps.theme, steps.posts].filter(Boolean).length;
  return (
    <Page>
      <BlockStack gap="500">
        <Card padding="0">
          <InlineGrid columns={{ xs: 1, md: 2 }}>
            <Box padding={{ xs: "500", md: "800" }}>
              <BlockStack gap="400">
                <Text as="p" variant="bodySm" tone="subdued" fontWeight="semibold">SOCIAL WALL</Text>
                <Text as="h1" variant="heading2xl">Make your customers the proof.</Text>
                <Text as="p" variant="bodyLg" tone="subdued">
                  Verified buyers share photos and videos of your products. You approve the best, reward them, and they
                  appear on an interactive wall in your store that shoppers can explore.
                </Text>
                <InlineStack gap="300">
                  {steps.wall ? (
                    <Button variant="primary" size="large" url="/app">Go to dashboard</Button>
                  ) : (
                    <Button variant="primary" size="large" url="/app/walls/new">Create your first wall</Button>
                  )}
                  <Button size="large" url="/app/demo">Explore an example wall</Button>
                </InlineStack>
              </BlockStack>
            </Box>
            <Link to="/app/demo" aria-label="Explore an example wall" style={{ display: "block", textDecoration: "none" }}>
              <div style={{ position: "relative", minHeight: 340, height: "100%", background: "#f3f2ee", overflow: "hidden" }}>
                {COLLAGE.map((p, i) => {
                  const [left, top, width, rot] = SPOTS[i];
                  return (
                    <img
                      key={p.id}
                      src={p.src}
                      alt=""
                      loading="lazy"
                      style={{
                        position: "absolute",
                        left: `${left}%`,
                        top: `${top}%`,
                        width: `${width}%`,
                        aspectRatio: p.height > p.width ? "4 / 5" : "4 / 3",
                        objectFit: "cover",
                        borderRadius: 8,
                        transform: `rotate(${rot}deg)`,
                        boxShadow: "0 6px 18px rgba(0,0,0,.14)",
                      }}
                    />
                  );
                })}
                <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", padding: "14px 22px", borderRadius: 18, background: "rgba(255,255,255,.82)", backdropFilter: "blur(10px)", textAlign: "center", color: "#111" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em" }}>Real people. Real moments.</div>
                  <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>See an example wall →</div>
                </div>
                <span style={{ position: "absolute", left: 12, bottom: 12, fontSize: 11, padding: "4px 8px", borderRadius: 999, background: "rgba(255,255,255,.9)", color: "#555" }}>Sample photos</span>
              </div>
            </Link>
          </InlineGrid>
        </Card>

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">How it works</Text>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            {STEPS.map((s, i) => (
              <Card key={s.title}>
                <BlockStack gap="200">
                  <span style={{ width: 28, height: 28, borderRadius: 999, background: "var(--p-color-bg-fill-brand)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 650, fontSize: 13 }}>{i + 1}</span>
                  <Text as="h3" variant="headingSm">{s.title}</Text>
                  <Text as="p" tone="subdued">{s.body}</Text>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </BlockStack>

        <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Get set up</Text>
                <Badge tone={done === 3 ? "success" : undefined}>{done === 3 ? "All done" : `${done} of 3 done`}</Badge>
              </InlineStack>
              <SetupRow n={1} done={steps.wall} title="Create your first wall campaign" body="Takes about two minutes." action={steps.wall ? undefined : <Button variant="primary" url="/app/walls/new">Create</Button>} />
              <Divider />
              <SetupRow n={2} done={steps.theme} title="Add the Social Wall block to your theme" body="Choose your wall campaign in the block's settings." action={steps.theme ? undefined : <Button url={themeUrl} target="_top">Open theme editor</Button>} />
              <Divider />
              <SetupRow
                n={3}
                done={steps.posts}
                title="Get your first posts"
                body="Share the wall's link with customers, or add a few of your own posts to start."
                action={!steps.posts && firstWallId ? <Button url={`/app/walls/${firstWallId}/posts`}>Add your own</Button> : undefined}
              />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">{`${planName} plan`}</Text>
                <Button variant="plain" url="/app/settings/billing">See plans</Button>
              </InlineStack>
              <Text as="p" tone="subdued">{planLine}</Text>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}

function SetupRow({ n, done, title, body, action }: { n: number; done: boolean; title: string; body: string; action?: React.ReactNode }) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        {done ? (
          <span style={{ width: 24, height: 24, flex: "0 0 24px", borderRadius: 999, background: "var(--p-color-bg-fill-success)", color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700 }} aria-label="Done">✓</span>
        ) : (
          <span style={{ width: 24, height: 24, flex: "0 0 24px", borderRadius: 999, border: "1.5px solid var(--p-color-border)", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600, color: "var(--p-color-text-secondary)" }}>{n}</span>
        )}
        <BlockStack gap="050">
          <Text as="p" fontWeight="semibold">{title}</Text>
          <Text as="p" variant="bodySm" tone="subdued">{body}</Text>
        </BlockStack>
      </InlineStack>
      {action}
    </InlineStack>
  );
}
