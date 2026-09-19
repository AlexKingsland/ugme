import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function seed() {
  console.log("🌱 Seeding database...");

  // Clean existing data
  await prisma.emailLog.deleteMany();
  await prisma.reward.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.shop.deleteMany();

  // Create shop
  const shop = await prisma.shop.create({
    data: {
      shopDomain: "ugme-demo.myshopify.com",
      accessToken: "shpat_fake_token_for_development",
      subscriptionProvider: "SHOPIFY_NATIVE",
      providerConnected: true,
      defaultRewardMonths: 1,
      brandName: "UGME Demo Store",
      logoUrl: null,
    },
  });
  console.log(`  ✓ Created shop: ${shop.shopDomain}`);

  // Create customers
  const customerData = [
    { email: "sarah@example.com", shopifyCustomerId: "gid://shopify/Customer/1001", subscriptionStatus: "ACTIVE" as const },
    { email: "mike@example.com", shopifyCustomerId: "gid://shopify/Customer/1002", subscriptionStatus: "ACTIVE" as const },
    { email: "emma@example.com", shopifyCustomerId: "gid://shopify/Customer/1003", subscriptionStatus: "ACTIVE" as const },
    { email: "james@example.com", shopifyCustomerId: "gid://shopify/Customer/1004", subscriptionStatus: "ACTIVE" as const },
    { email: "olivia@example.com", shopifyCustomerId: "gid://shopify/Customer/1005", subscriptionStatus: "PAUSED" as const },
    { email: "noah@example.com", shopifyCustomerId: "gid://shopify/Customer/1006", subscriptionStatus: "CANCELLED" as const },
    { email: "ava@example.com", shopifyCustomerId: "gid://shopify/Customer/1007", subscriptionStatus: "ACTIVE" as const },
    { email: "liam@example.com", shopifyCustomerId: "gid://shopify/Customer/1008", subscriptionStatus: "ACTIVE" as const },
  ];

  const customers = await Promise.all(
    customerData.map((c) =>
      prisma.customer.create({
        data: { shopId: shop.id, ...c },
      })
    )
  );
  console.log(`  ✓ Created ${customers.length} customers`);

  // Create campaigns
  const campaigns = await Promise.all([
    prisma.campaign.create({
      data: {
        shopId: shop.id,
        title: "Morning Routine with Our Coffee Blend",
        status: "ACTIVE",
        moment: "Show us your morning coffee ritual — the pour, the steam, the first sip. We want to see our blend in your real morning, not a studio setup.",
        captureSpecs: JSON.stringify([
          { type: "content_type", value: "PHOTO", label: "Photo only" },
          { type: "orientation", value: "vertical", label: "Vertical/portrait orientation" },
          { type: "quality", value: "min_1080p", label: "Minimum 1080x1920 resolution" },
          { type: "brand", value: "product_visible", label: "Our product packaging must be visible" },
        ]),
        rewardMonths: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-10-31"),
        maxSubmissions: 50,
      },
    }),
    prisma.campaign.create({
      data: {
        shopId: shop.id,
        title: "Unboxing Day",
        status: "ACTIVE",
        moment: "Film or photograph the moment you open your monthly box. We want genuine reactions — surprise, excitement, the first look at what's inside.",
        captureSpecs: JSON.stringify([
          { type: "content_type", value: "PHOTO", label: "Photo or video" },
          { type: "quality", value: "min_720p", label: "Minimum 720p" },
          { type: "brand", value: "box_visible", label: "Subscription box must be visible" },
          { type: "compliance", value: "no_competitors", label: "No competitor products in frame" },
        ]),
        rewardMonths: 1,
        startDate: new Date("2026-09-15"),
        endDate: null,
        maxSubmissions: null,
      },
    }),
    prisma.campaign.create({
      data: {
        shopId: shop.id,
        title: "End of Day Wind-Down",
        status: "DRAFT",
        moment: "Capture your evening routine featuring our wellness tea. Cozy lighting, relaxation vibes — show us how you wind down.",
        captureSpecs: JSON.stringify([
          { type: "content_type", value: "PHOTO", label: "Photo only" },
          { type: "orientation", value: "any", label: "Any orientation" },
          { type: "brand", value: "product_visible", label: "Tea product must be visible" },
        ]),
        rewardMonths: 2,
        startDate: null,
        endDate: null,
        maxSubmissions: 30,
      },
    }),
    prisma.campaign.create({
      data: {
        shopId: shop.id,
        title: "Summer Outdoor Adventures",
        status: "CLOSED",
        moment: "Take our protein bars on your summer hike, bike ride, or beach day. Show the bar in action — mid-trail, at the summit, wherever the adventure takes you.",
        captureSpecs: JSON.stringify([
          { type: "content_type", value: "PHOTO", label: "Photo only" },
          { type: "quality", value: "min_1080p", label: "Minimum 1080p" },
          { type: "brand", value: "product_in_hand", label: "Product must be in hand or clearly visible" },
        ]),
        rewardMonths: 1,
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-08-31"),
        maxSubmissions: 100,
      },
    }),
    prisma.campaign.create({
      data: {
        shopId: shop.id,
        title: "Workspace Setup",
        status: "PAUSED",
        moment: "Show us your desk or workspace with our planner front and center. We want to see how our product fits into your daily productivity setup.",
        captureSpecs: JSON.stringify([
          { type: "content_type", value: "PHOTO", label: "Photo only" },
          { type: "orientation", value: "horizontal", label: "Landscape orientation" },
          { type: "quality", value: "min_1080p", label: "Minimum 1080p" },
        ]),
        rewardMonths: 1,
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-12-31"),
        maxSubmissions: 40,
      },
    }),
  ]);
  console.log(`  ✓ Created ${campaigns.length} campaigns`);

  // Create submissions (spread across campaigns and statuses)
  const placeholderUrls = [
    "https://placehold.co/1080x1920/e8d5b7/3d2c1f?text=Coffee+Morning",
    "https://placehold.co/1080x1920/c4e8d5/1f3d2c?text=Unboxing",
    "https://placehold.co/1080x1920/d5c4e8/2c1f3d?text=Tea+Evening",
    "https://placehold.co/1080x1920/e8c4c4/3d1f1f?text=Outdoor+Bar",
    "https://placehold.co/1920x1080/c4d5e8/1f2c3d?text=Workspace",
  ];

  const submissionData = [
    // Campaign 0: Morning Coffee (ACTIVE) - 6 submissions
    { campaignIdx: 0, customerIdx: 0, status: "APPROVED" as const, url: placeholderUrls[0] },
    { campaignIdx: 0, customerIdx: 1, status: "APPROVED" as const, url: placeholderUrls[0] },
    { campaignIdx: 0, customerIdx: 2, status: "PENDING" as const, url: placeholderUrls[0] },
    { campaignIdx: 0, customerIdx: 3, status: "PENDING" as const, url: placeholderUrls[0] },
    { campaignIdx: 0, customerIdx: 6, status: "REJECTED" as const, url: placeholderUrls[0] },
    { campaignIdx: 0, customerIdx: 7, status: "FLAGGED" as const, url: placeholderUrls[0] },

    // Campaign 1: Unboxing (ACTIVE) - 5 submissions
    { campaignIdx: 1, customerIdx: 0, status: "APPROVED" as const, url: placeholderUrls[1] },
    { campaignIdx: 1, customerIdx: 1, status: "APPROVED" as const, url: placeholderUrls[1] },
    { campaignIdx: 1, customerIdx: 2, status: "APPROVED" as const, url: placeholderUrls[1] },
    { campaignIdx: 1, customerIdx: 3, status: "PENDING" as const, url: placeholderUrls[1] },
    { campaignIdx: 1, customerIdx: 7, status: "PENDING" as const, url: placeholderUrls[1] },

    // Campaign 3: Summer Outdoor (CLOSED) - 5 submissions
    { campaignIdx: 3, customerIdx: 0, status: "APPROVED" as const, url: placeholderUrls[3] },
    { campaignIdx: 3, customerIdx: 1, status: "APPROVED" as const, url: placeholderUrls[3] },
    { campaignIdx: 3, customerIdx: 2, status: "APPROVED" as const, url: placeholderUrls[3] },
    { campaignIdx: 3, customerIdx: 3, status: "APPROVED" as const, url: placeholderUrls[3] },
    { campaignIdx: 3, customerIdx: 6, status: "REJECTED" as const, url: placeholderUrls[3] },

    // Campaign 4: Workspace (PAUSED) - 2 submissions
    { campaignIdx: 4, customerIdx: 0, status: "APPROVED" as const, url: placeholderUrls[4] },
    { campaignIdx: 4, customerIdx: 7, status: "PENDING" as const, url: placeholderUrls[4] },
  ];

  const submissions = await Promise.all(
    submissionData.map((s, i) =>
      prisma.submission.create({
        data: {
          campaignId: campaigns[s.campaignIdx].id,
          customerId: customers[s.customerIdx].id,
          status: s.status,
          contentType: "PHOTO",
          contentUrl: s.url,
          thumbnailUrl: s.url,
          reviewedAt: s.status !== "PENDING" ? new Date(Date.now() - (18 - i) * 86400000) : null,
          reviewNote: s.status === "REJECTED" ? "Content didn't meet the capture requirements." : null,
        },
      })
    )
  );
  console.log(`  ✓ Created ${submissions.length} submissions`);

  // Create rewards for approved submissions
  const approvedSubmissions = submissions.filter(
    (_, i) => submissionData[i].status === "APPROVED"
  );

  const rewards = await Promise.all(
    approvedSubmissions.map((sub, i) => {
      const subData = submissionData[submissions.indexOf(sub)];
      return prisma.reward.create({
        data: {
          submissionId: sub.id,
          customerId: customers[subData.customerIdx].id,
          months: campaigns[subData.campaignIdx].rewardMonths,
          discountProvider: "SHOPIFY_NATIVE",
          externalDiscountId: `disc_fake_${i + 1}`,
          appliedAt: new Date(Date.now() - (10 - i) * 86400000),
          status: "APPLIED",
        },
      });
    })
  );
  console.log(`  ✓ Created ${rewards.length} rewards`);

  console.log("\n✅ Seed complete!");
  console.log(`   Shop: ${shop.shopDomain}`);
  console.log(`   Campaigns: ${campaigns.length} (2 active, 1 draft, 1 closed, 1 paused)`);
  console.log(`   Customers: ${customers.length} (6 active, 1 paused, 1 cancelled)`);
  console.log(`   Submissions: ${submissions.length}`);
  console.log(`   Rewards: ${rewards.length}`);
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
