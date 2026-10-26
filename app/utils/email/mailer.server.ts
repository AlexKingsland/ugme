/**
 * Transactional email.
 *
 * - RESEND_API_KEY set  → sends through Resend (https://resend.com) via its REST API.
 * - not set             → "preview mode": writes each email to .email-previews/
 *                         as an .html file (and logs it) so flows can be tested
 *                         locally without sending anything.
 *
 * Env:
 *   RESEND_API_KEY   re_…
 *   EMAIL_FROM       e.g. "UGME Rewards <rewards@mail.yourdomain.com>" (domain must be
 *                    verified in Resend). Defaults to Resend's test sender, which can
 *                    only deliver to the Resend account owner's own address.
 *   EMAIL_REPLY_TO   optional
 *   EMAIL_PREVIEW_DIR  where preview mode writes (default .email-previews/)
 *
 * Swapping provider = replace sendViaResend() — nothing else depends on Resend.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Display name shown before the sender address, e.g. the merchant's brand. */
  fromName?: string;
  replyTo?: string;
  /** Short labels for provider analytics, e.g. { type: "submission_approved" }. */
  tags?: Record<string, string>;
}

export interface SentEmail {
  provider: "resend" | "preview";
  id: string;
}

const DEFAULT_FROM = "Social Wall <onboarding@resend.dev>";

function fromHeader(fromName?: string) {
  const configured = process.env.EMAIL_FROM || DEFAULT_FROM;
  if (!fromName) return configured;
  // Keep the configured address, swap in the brand as display name
  const address = configured.match(/<([^>]+)>/)?.[1] || configured;
  const safeName = fromName.replace(/["<>\r\n]/g, "").slice(0, 60);
  return `"${safeName}" <${address}>`;
}

async function sendViaResend(email: OutgoingEmail): Promise<SentEmail> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromHeader(email.fromName),
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      reply_to: email.replyTo || process.env.EMAIL_REPLY_TO || undefined,
      tags: email.tags
        ? Object.entries(email.tags).map(([name, value]) => ({
            name,
            value: value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256),
          }))
        : undefined,
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${body?.message || body?.name || "send failed"}`);
  }
  return { provider: "resend", id: String(body.id) };
}

async function writePreview(email: OutgoingEmail): Promise<SentEmail> {
  const dir = process.env.EMAIL_PREVIEW_DIR || join(process.cwd(), ".email-previews");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = email.subject.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 50);
  const file = join(dir, `${stamp}-${slug}.html`);
  const header = `<!-- To: ${email.to}\n     From: ${fromHeader(email.fromName)}\n     Subject: ${email.subject} -->\n`;
  await writeFile(file, header + email.html, "utf8");
  await writeFile(file.replace(/\.html$/, ".txt"), `To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}`, "utf8");
  console.log(`[UGME] Email preview (no RESEND_API_KEY): "${email.subject}" → ${email.to}  ${file}`);
  return { provider: "preview", id: file };
}

export async function sendEmail(email: OutgoingEmail): Promise<SentEmail> {
  if (!email.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.to)) {
    throw new Error(`Invalid recipient: ${email.to}`);
  }
  return process.env.RESEND_API_KEY ? sendViaResend(email) : writePreview(email);
}
