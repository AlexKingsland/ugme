/**
 * Customer email templates. Plain functions returning { subject, html, text }.
 * Layout lives here; the reward-specific wording comes from
 * app/utils/rewards/presenters.ts (one presenter per reward type).
 * HTML is table-based with inline styles so it renders in Gmail/Outlook/Apple Mail.
 */
import { esc, presentReward, type RewardDetails } from "../rewards/presenters";

export type { RewardDetails } from "../rewards/presenters";

export interface ApprovedEmailInput {
  brandName: string;
  logoUrl?: string | null;
  shopDomain: string;
  customerEmail: string;
  campaignTitle: string;
  contentType: "VIDEO" | "PHOTO";
  productTitle?: string | null;
  currency?: string;
  reward: RewardDetails;
}

export function submissionApprovedEmail(input: ApprovedEmailInput) {
  const shopUrl = `https://${input.shopDomain}`;
  const accountUrl = `${shopUrl}/apps/ugme/account`;
  const media = input.contentType === "VIDEO" ? "video" : "photo";
  const p = presentReward(input.reward, {
    shopUrl,
    accountUrl,
    customerEmail: input.customerEmail,
    productTitle: input.productTitle,
    currency: input.currency,
  });

  const subject = `Your ${media} was approved — ${p.subjectTail}`;

  const codeBox = p.code
    ? `<div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:.06em;color:#064e3b;background:#ffffff;border:2px dashed #10b981;border-radius:10px;padding:12px 18px;margin-top:4px;">${esc(p.code)}</div>`
    : "";
  const facts = p.facts.length
    ? `<div style="font-size:13px;color:#047857;margin-top:12px;">${p.facts.map(esc).join(" &nbsp;·&nbsp; ")}</div>`
    : "";
  const note = p.noteHtml ? `<div style="font-size:14px;color:#047857;margin-top:${p.code ? 12 : 0}px;">${p.noteHtml}</div>` : "";

  const logo = input.logoUrl
    ? `<img src="${esc(input.logoUrl)}" alt="${esc(input.brandName)}" height="36" style="display:block;height:36px;width:auto;border:0;">`
    : `<div style="font-size:18px;font-weight:700;color:#111827;">${esc(input.brandName)}</div>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(`${p.headline} ${p.sub}`)} — thanks for your ${media}!</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <tr><td style="padding:24px 32px;border-bottom:1px solid #f0f0f0;">${logo}</td></tr>
    <tr><td style="padding:32px 32px 8px;">
      <div style="font-size:26px;font-weight:800;line-height:1.25;margin:0 0 10px;">You're approved! 🎉</div>
      <div style="font-size:16px;line-height:1.55;color:#374151;">Thanks for sharing your ${media} for <b>${esc(input.campaignTitle)}</b>. ${esc(input.brandName)} loved it and approved your submission.</div>
    </td></tr>
    <tr><td style="padding:20px 32px;">
      <div style="background:#ecfdf5;border-radius:14px;padding:24px;text-align:center;">
        <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#065f46;font-weight:600;margin-bottom:6px;">Your reward</div>
        <div style="font-size:30px;font-weight:800;color:#064e3b;line-height:1.1;">${esc(p.headline)}</div>
        <div style="font-size:15px;color:#065f46;margin:2px 0 12px;">${esc(p.sub)}</div>
        ${codeBox}${facts}${note}
      </div>
    </td></tr>
    <tr><td style="padding:4px 32px 8px;">
      <div style="font-size:15px;font-weight:700;margin-bottom:8px;">How to use it</div>
      <ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:#374151;">${p.howToHtml.map((h) => `<li style="margin-bottom:4px;">${h}</li>`).join("")}</ol>
    </td></tr>
    <tr><td align="center" style="padding:24px 32px 32px;">
      <a href="${esc(p.cta.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:999px;">${esc(p.cta.label)}</a>
      <div style="font-size:13px;color:#6b7280;margin-top:14px;"><a href="${esc(accountUrl)}" style="color:#6b7280;">See all your submissions and rewards</a></div>
    </td></tr>
    <tr><td style="padding:18px 32px;background:#fafafa;border-top:1px solid #f0f0f0;font-size:12px;line-height:1.5;color:#9ca3af;">
      You're receiving this because you submitted a ${media} to ${esc(input.brandName)}. Powered by UGME.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = `You're approved!

Thanks for sharing your ${media} for "${input.campaignTitle}". ${input.brandName} approved your submission.

${p.text}

See all your submissions and rewards: ${accountUrl}

You're receiving this because you submitted a ${media} to ${input.brandName}. Powered by UGME.`;

  return { subject, html, text };
}
