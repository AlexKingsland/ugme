import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";
import prisma from "../../db.server";

/**
 * Content upload page for a specific campaign.
 * URL: /submit/:campaignId?token=xxx
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const { campaignId } = params;

  if (!token || !campaignId) {
    return json({ error: "Invalid link", campaign: null }, { status: 400 });
  }

  // TODO: validate token properly
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      title: true,
      description: true,
      contentType: true,
      rewardMonths: true,
      maxDurationSec: true,
      minResolution: true,
    },
  });

  if (!campaign) {
    return json({ error: "Campaign not found", campaign: null }, { status: 404 });
  }

  return json({ error: null, campaign });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const { campaignId } = params;

  // TODO: Handle actual file upload to S3/R2
  // For now, create a submission record with placeholder data
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  const customer = await prisma.customer.findFirst({
    where: { email: { not: "" } }, // placeholder token validation
  });

  if (!customer || !campaignId) {
    return json({ error: "Invalid submission" }, { status: 400 });
  }

  const submission = await prisma.submission.create({
    data: {
      campaignId,
      customerId: customer.id,
      videoUrl: "https://placeholder.ugme.app/pending-upload", // TODO: real upload URL
      thumbnailUrl: null,
      durationSec: 0,
      status: "PENDING",
    },
  });

  return redirect(`/submit/confirmation?submissionId=${submission.id}`);
}

export default function SubmitCampaign() {
  const { error, campaign } = useLoaderData<typeof loader>();

  if (error || !campaign) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0" }}>
        <h2 style={{ color: "#dc2626" }}>Oops!</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div>
      <h2>{campaign.title}</h2>
      {campaign.description && <p style={{ color: "#6b7280" }}>{campaign.description}</p>}

      <div
        style={{
          padding: "16px",
          background: "#f9fafb",
          borderRadius: "8px",
          margin: "24px 0",
        }}
      >
        <h3 style={{ margin: "0 0 8px", fontSize: "14px", textTransform: "uppercase", color: "#6b7280" }}>
          Requirements
        </h3>
        <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "14px" }}>
          <li>Content type: {campaign.contentType}</li>
          {campaign.maxDurationSec && <li>Max duration: {campaign.maxDurationSec} seconds</li>}
          {campaign.minResolution && <li>Min resolution: {campaign.minResolution}</li>}
        </ul>
      </div>

      <div
        style={{
          padding: "16px",
          background: "#ecfdf5",
          borderRadius: "8px",
          marginBottom: "24px",
        }}
      >
        <strong>Reward:</strong> {campaign.rewardMonths} month{campaign.rewardMonths !== 1 ? "s" : ""} free on your subscription
      </div>

      <Form method="post" encType="multipart/form-data">
        {/* TODO: Replace with proper file upload component (drag & drop, S3 presigned URL) */}
        <div
          style={{
            border: "2px dashed #d1d5db",
            borderRadius: "8px",
            padding: "48px",
            textAlign: "center",
            marginBottom: "24px",
          }}
        >
          <p style={{ margin: "0 0 8px", fontWeight: 500 }}>Upload your video</p>
          <p style={{ margin: "0 0 16px", color: "#6b7280", fontSize: "14px" }}>
            Drag and drop or click to browse
          </p>
          <input type="file" name="video" accept="video/*" />
        </div>
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "12px",
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: "8px",
            fontSize: "16px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Submit Content
        </button>
      </Form>
    </div>
  );
}
