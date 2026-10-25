/**
 * Customer notifications. Each send is recorded in EmailLog and guarded so a
 * customer never gets the same email twice (approval retries, the retry
 * script, double clicks…). Email failures never break approval.
 */
import prisma from "../../db.server";
import { sendEmail } from "./mailer.server";
import { submissionApprovedEmail, type RewardDetails } from "./templates";

export type NotifyResult = { status: "sent" | "already_sent" | "skipped" | "failed"; detail?: string };

/**
 * "Your submission was approved — here's your reward". Sent once the reward
 * has actually been delivered (Reward.status APPLIED), so the email always
 * contains a working code / an applied discount.
 */
export async function sendRewardDeliveredEmail(submissionId: string): Promise<NotifyResult> {
  try {
    const sub = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        campaign: { include: { shop: true } },
        customer: true,
        reward: true,
      },
    });
    if (!sub || sub.status !== "APPROVED") return { status: "skipped", detail: "submission not approved" };
    if (!sub.reward || sub.reward.status !== "APPLIED") return { status: "skipped", detail: "reward not delivered yet" };
    if (!sub.customer.email) return { status: "skipped", detail: "customer has no email" };

    const logs = await prisma.emailLog.findMany({
      where: { customerId: sub.customerId, type: "SUBMISSION_APPROVED", metadata: { contains: `"submissionId":"${submissionId}"` } },
      select: { metadata: true },
    });
    // Preview-mode "sends" (no RESEND_API_KEY) don't count once real sending is configured
    const realSendingOn = !!process.env.RESEND_API_KEY;
    const counted = logs.filter((l) => !realSendingOn || !l.metadata.includes(`"provider":"preview"`));
    if (counted.length) return { status: "already_sent" };

    const c = sub.campaign;
    const shop = c.shop;
    const reward: RewardDetails =
      c.rewardType === "DISCOUNT_CODE"
        ? {
            kind: "DISCOUNT_CODE" as const,
            code: sub.reward.discountCode || "",
            valueType: (c.discountCodeType === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENTAGE") as "FIXED_AMOUNT" | "PERCENTAGE",
            amount: Number(c.discountCodeAmount || 0),
            minimumSubtotal: c.discountCodeMinOrder,
            expiresAt: sub.reward.expiresAt,
          }
        : {
            kind: "SUBSCRIPTION_DISCOUNT" as const,
            discountType: c.discountType as "FREE" | "PERCENTAGE" | "FIXED_AMOUNT",
            value: c.discountValue,
            cycles: sub.reward.cycles || c.rewardCycles,
            frequency: (c.rewardFrequency || "MONTH") as "DAY" | "WEEK" | "MONTH",
            code: sub.reward.discountCode,
          };
    if (reward.kind === "DISCOUNT_CODE" && !reward.code) return { status: "skipped", detail: "no discount code recorded" };

    const brandName = shop.brandName || shop.shopDomain.replace(".myshopify.com", "");
    const email = submissionApprovedEmail({
      brandName,
      logoUrl: shop.logoUrl,
      shopDomain: shop.shopDomain,
      customerEmail: sub.customer.email,
      campaignTitle: c.title,
      contentType: sub.contentType,
      productTitle: c.productTitle,
      reward,
    });

    const sent = await sendEmail({
      to: sub.customer.email,
      ...email,
      fromName: brandName,
      tags: { type: "submission_approved", shop: shop.shopDomain },
    });

    await prisma.emailLog.create({
      data: {
        customerId: sub.customerId,
        type: "SUBMISSION_APPROVED",
        metadata: JSON.stringify({ submissionId, rewardId: sub.reward.id, provider: sent.provider, messageId: sent.id }),
      },
    });
    return { status: "sent", detail: sent.provider === "preview" ? `preview: ${sent.id}` : `resend: ${sent.id}` };
  } catch (err) {
    console.error("[UGME] Reward email failed:", err);
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
