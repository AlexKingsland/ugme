/**
 * Renders the approval email for every reward type × value type × billing
 * period and checks for broken output (undefined/NaN/[object …], empty
 * sections, over-long subjects). Writes previews to .email-previews/matrix/.
 *
 *   npm run test:emails
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { submissionApprovedEmail, type RewardDetails } from "../app/utils/email/templates";

const base = {
  brandName: "Acme Coffee",
  shopDomain: "acme-coffee.myshopify.com",
  customerEmail: "sam@example.com",
  campaignTitle: "Morning routine",
  contentType: "VIDEO" as const,
  productTitle: "The House Blend",
};
const cases: [string, RewardDetails][] = [];
for (const valueType of ["PERCENTAGE", "FIXED_AMOUNT"] as const) {
  cases.push([`code-${valueType}`, { kind: "DISCOUNT_CODE", code: "UGME-TEST-ABC123", valueType, amount: valueType === "PERCENTAGE" ? 20 : 7.5 }]);
  cases.push([`code-${valueType}-min-expiry`, { kind: "DISCOUNT_CODE", code: "UGME-TEST-ABC123", valueType, amount: 15, minimumSubtotal: 50, expiresAt: new Date("2026-12-01") }]);
}
for (const discountType of ["FREE", "PERCENTAGE", "FIXED_AMOUNT"] as const)
  for (const frequency of ["DAY", "WEEK", "MONTH"] as const)
    for (const cycles of [1, 3])
      cases.push([`sub-${discountType}-${cycles}x${frequency}`, { kind: "SUBSCRIPTION_DISCOUNT", discountType, value: discountType === "PERCENTAGE" ? 25 : 10, cycles, frequency, code: cycles > 1 ? "UGME-SUB-XYZ" : null }]);
cases.push(["store-credit", { kind: "STORE_CREDIT", amount: 15 }]);
cases.push(["store-credit-expiry", { kind: "STORE_CREDIT", amount: 12.5, expiresAt: new Date("2027-01-31") }]);

mkdirSync(".email-previews/matrix", { recursive: true });
let failures = 0;
for (const [name, reward] of cases) {
  const e = submissionApprovedEmail({ ...base, reward });
  const problems: string[] = [];
  for (const [part, body] of [["subject", e.subject], ["html", e.html], ["text", e.text]] as const) {
    if (/undefined|NaN|\[object |null(?![a-z])/.test(body)) problems.push(`${part} contains undefined/NaN/null`);
  }
  if (e.subject.length > 78) problems.push(`subject too long (${e.subject.length})`);
  if (!/How to use it/.test(e.html)) problems.push("missing how-to section");
  writeFileSync(`.email-previews/matrix/${name}.html`, e.html);
  if (problems.length) failures++;
  console.log(`${problems.length ? "✗" : "✓"} ${name.padEnd(30)} ${e.subject}${problems.length ? `\n    ${problems.join("; ")}` : ""}`);
}
console.log(failures ? `\n${failures} template case(s) failed` : `\nAll ${cases.length} template cases OK (previews in .email-previews/matrix/)`);
process.exitCode = failures ? 1 : 0;
