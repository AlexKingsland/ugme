/**
 * Submission Terms — what customers agree to when they share, and what merchants
 * review when they set up a wall campaign. One source of truth for both sides.
 *
 * Bump TERMS_VERSION whenever the wording changes: each submission stores the
 * version the customer agreed to (section 9), and new versions only apply to new
 * submissions.
 */

export const TERMS_VERSION = "2026-11-25";
export const REMOVAL_DAYS = 30;

export type TermsVars = {
  brandName: string;
  /** Where customers contact the merchant (Settings → Brand → Support email) */
  merchantSupportEmail: string | null;
};

/** Social Wall's own details, from the server environment (never hard-coded). */
export function socialWallDetails() {
  return {
    legalName: process.env.SW_LEGAL_NAME?.trim() || "Social Wall",
    address: process.env.SW_ADDRESS?.trim() || "",
    privacyEmail: process.env.SW_PRIVACY_EMAIL?.trim() || "",
  };
}

/** The short version shown next to the checkbox. */
export function termsSummary(brandName: string): string {
  return `${brandName} can use my photo or video on its store, social media and ads. I have the right to share it, everyone in it has agreed to be featured, and I can ask for it to be taken down anytime.`;
}

export type TermsBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };
export type TermsSection = { heading: string; blocks: TermsBlock[] };

/** The full Submission Terms, as plain text blocks (rendered as HTML or Polaris by callers). */
export function fullTerms(vars: TermsVars, sw = socialWallDetails()): { intro: string; sections: TermsSection[] } {
  const brand = vars.brandName;
  const contact = vars.merchantSupportEmail ? `${brand} at ${vars.merchantSupportEmail}` : brand;
  const p = (text: string): TermsBlock => ({ type: "p", text });
  const ul = (...items: string[]): TermsBlock => ({ type: "ul", items });
  const swContact = [sw.legalName, sw.address, sw.privacyEmail].filter(Boolean).join(", ");

  return {
    intro: `These terms apply when you submit a photo, video, name or caption ("your content") to ${brand} through Social Wall. Social Wall is operated by ${sw.legalName}. It provides the technology and hosts your content for ${brand}.`,
    sections: [
      { heading: "1. You keep ownership", blocks: [p(`You own your content. These terms only give ${brand} permission to use it as described below.`)] },
      {
        heading: "2. What you allow",
        blocks: [
          p(`You give ${brand} a non-exclusive, worldwide, royalty-free license to show, copy, store and share your content, with the name and caption you added, on:`),
          ul(
            `${brand}'s online store, including its Social Wall and links to your feature that anyone can open`,
            "its website and emails",
            "its social media accounts",
            "its advertising, including paid ads on other websites and apps",
          ),
          p(`${brand} may resize, crop, format or compress your content to fit these places, and show it next to products, branding or other customers' content. ${brand} won't edit it in a misleading way or present it as saying something you didn't say.`),
          p(`Social Wall may store, process and display your content only to provide this service to ${brand}. Social Wall doesn't sell your content and doesn't use it to advertise Social Wall.`),
        ],
      },
      {
        heading: "3. What you confirm",
        blocks: [
          p("By submitting, you confirm that:"),
          ul(
            "you took the photo or video, or the person who did agreed to you sharing it on these terms;",
            "everyone who can be recognized in it agreed to it being shared this way;",
            "if a child can be recognized in it, you're their parent or legal guardian, or you have that person's permission;",
            "you're an adult where you live;",
            "it doesn't include music, artwork or other material you don't have the right to share, and it doesn't break any law or anyone else's rights;",
            "it reflects your own genuine experience.",
          ),
          p(`If any of this isn't true, ${brand} may remove your content.`),
        ],
      },
      {
        heading: "4. Credit",
        blocks: [
          p("Your content is shown with the name or caption you entered. Some formats, like certain ads, may not allow a credit. You agree your content can be used there without one. To the extent the law allows, you waive any moral rights that would prevent the uses in section 2."),
        ],
      },
      {
        heading: "5. Review and rewards",
        blocks: [
          p(`${brand} reviews every submission and decides whether to approve and publish it. Decisions are based on its photo guidelines, such as quality, relevance and appropriateness, not on whether your content is positive.`),
          p("If a request offers a reward, you get it when your submission is approved, under the conditions shown on the request. If your content is removed later, including at your request, you keep any reward you already received. Approval doesn't guarantee your content will be published or how long it stays up."),
          p("Apart from any reward shown on the request, you won't be paid for your content."),
        ],
      },
      {
        heading: "6. Removing your content",
        blocks: [
          p(`You can ask for your content to be removed anytime from your account, or by contacting ${contact}. When you do:`),
          ul(
            "it's taken off the Social Wall promptly;",
            `${brand} won't use it in anything new;`,
            `${brand} will take it down from its website, social media and ads within ${REMOVAL_DAYS} days.`,
          ),
          p("Emails already sent, and copies other people have saved or shared, can't be recalled. Asking for removal also withdraws any consent you gave for the use of your image under privacy laws."),
        ],
      },
      {
        heading: "7. Your personal information",
        blocks: [
          p(`${brand} decides how your content and information are used. Social Wall processes them on ${brand}'s behalf. We remove location data, like GPS coordinates, from uploaded files. Learn more in the Social Wall Privacy Policy and ${brand}'s own privacy policy. Depending on where you live, you may have the right to access, correct or delete your information. Contact ${contact} to use those rights.`),
        ],
      },
      {
        heading: "8. Reporting a problem",
        blocks: [p(`If you see content that uses your work or your image without permission, use "Report" on the photo or see our Copyright & Content Policy.`)],
      },
      {
        heading: "9. Changes to these terms",
        blocks: [p("If these terms change, the new version applies only to new submissions. The version you agreed to stays attached to your submission.")],
      },
      {
        heading: "10. Your rights under local law",
        blocks: [p("Nothing in these terms limits rights you have under the consumer protection or privacy laws where you live.")],
      },
      {
        heading: "Contact",
        blocks: [p(`Questions about your submission: ${vars.merchantSupportEmail ? `${brand}, ${vars.merchantSupportEmail}` : brand}. Questions about Social Wall: ${swContact}.`)],
      },
    ],
  };
}

/** HTML for the share page (every value escaped). */
export function fullTermsHtml(vars: TermsVars, escape: (s: string) => string): string {
  const t = fullTerms(vars);
  const block = (b: TermsBlock) =>
    b.type === "p"
      ? `<p style="margin: 0 0 8px;">${escape(b.text)}</p>`
      : `<ul style="margin: 0 0 8px; padding-left: 18px; display: flex; flex-direction: column; gap: 4px;">${b.items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>`;
  return [
    `<div style="font-weight: 600; color: var(--ugme-fg); margin-bottom: 2px;">Submission Terms</div>`,
    `<div style="font-style: italic; margin-bottom: 10px;">Version ${escape(TERMS_VERSION)}</div>`,
    `<p style="margin: 0 0 12px;">${escape(t.intro)}</p>`,
    ...t.sections.map(
      (s) => `<div style="margin-bottom: 10px;"><div style="font-weight: 600; color: var(--ugme-fg); margin-bottom: 4px;">${escape(s.heading)}</div>${s.blocks.map(block).join("")}</div>`,
    ),
  ].join("");
}
