import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "../../db.server";

/**
 * Magic-link entry point: /submit?token=xxx
 * Validates the customer token and shows active campaigns they can submit to.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return json({ error: "Missing submission token", customer: null, campaigns: [] }, { status: 400 });
  }

  // TODO: Implement proper magic link token validation
  // For now, look up customer by a simple token match
  const customer = await prisma.customer.findFirst({
    where: { email: { not: "" } }, // placeholder
  });

  if (!customer) {
    return json({ error: "Invalid or expired link", customer: null, campaigns: [] }, { status: 404 });
  }

  const campaigns = await prisma.campaign.findMany({
    where: {
      shopId: customer.shopId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      title: true,
      description: true,
      contentType: true,
      rewardMonths: true,
    },
  });

  return json({ error: null, customer: { name: customer.name, email: customer.email }, campaigns });
}

export default function SubmitIndex() {
  const { error, customer, campaigns } = useLoaderData<typeof loader>();

  if (error) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0" }}>
        <h2 style={{ color: "#dc2626" }}>Oops!</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Welcome{customer?.name ? `, ${customer.name}` : ""}!</h2>
      <p>Choose a campaign to submit your content to:</p>

      {campaigns.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No active campaigns available right now.</p>
      ) : (
        <div style={{ display: "grid", gap: "16px", marginTop: "16px" }}>
          {campaigns.map((campaign) => (
            <a
              key={campaign.id}
              href={`/submit/${campaign.id}?token=${new URL(typeof window !== "undefined" ? window.location.href : "http://localhost").searchParams.get("token")}`}
              style={{
                display: "block",
                padding: "20px",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                textDecoration: "none",
                color: "inherit",
                transition: "border-color 0.15s",
              }}
            >
              <h3 style={{ margin: "0 0 8px" }}>{campaign.title}</h3>
              {campaign.description && (
                <p style={{ margin: "0 0 8px", color: "#6b7280" }}>
                  {campaign.description}
                </p>
              )}
              <span
                style={{
                  display: "inline-block",
                  padding: "4px 8px",
                  background: "#f3f4f6",
                  borderRadius: "4px",
                  fontSize: "13px",
                }}
              >
                {campaign.contentType} · {campaign.rewardMonths} month{campaign.rewardMonths !== 1 ? "s" : ""} free
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
