import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "../../db.server";

/**
 * Thank-you page shown after a successful submission.
 * URL: /submit/confirmation?submissionId=xxx
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const submissionId = url.searchParams.get("submissionId");

  if (!submissionId) {
    return json({ submission: null });
  }

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      campaign: { select: { title: true, rewardMonths: true } },
    },
  });

  return json({ submission });
}

export default function SubmitConfirmation() {
  const { submission } = useLoaderData<typeof loader>();

  return (
    <div style={{ textAlign: "center", padding: "48px 0" }}>
      <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#10003;</div>
      <h2>Thank you!</h2>
      <p>Your content has been submitted for review.</p>

      {submission?.campaign && (
        <div
          style={{
            padding: "16px",
            background: "#f9fafb",
            borderRadius: "8px",
            display: "inline-block",
            marginTop: "16px",
            textAlign: "left",
          }}
        >
          <p style={{ margin: "0 0 4px" }}>
            <strong>Campaign:</strong> {submission.campaign.title}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Reward:</strong> {submission.campaign.rewardMonths} month
            {submission.campaign.rewardMonths !== 1 ? "s" : ""} free (applied after approval)
          </p>
        </div>
      )}

      <p style={{ marginTop: "24px", color: "#6b7280", fontSize: "14px" }}>
        You'll receive an email when your submission has been reviewed.
      </p>
    </div>
  );
}
