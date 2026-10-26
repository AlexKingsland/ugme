/** Wall campaign form shape + validation (shared by the admin editor and tests). */
import type { WallProduct } from "./wall-campaigns";

export type RewardChoice = "NONE" | "DISCOUNT_CODE" | "STORE_CREDIT";

export type WallForm = {
  title: string;
  moment: string;
  checklist: string[];
  contentType: "VIDEO" | "PHOTO";
  productScope: "SPECIFIC" | "ALL";
  products: WallProduct[];
  rewardType: RewardChoice;
  discountCodeType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountCodeAmount: string;
  discountCodeMinOrder: string;
  discountCodeExpiryDays: string;
  storeCreditAmount: string;
  storeCreditExpiryDays: string;
  /** Cap on how many customers can share to this wall */
  hasLimit: boolean;
  maxSubmissions: string;
  /** Merchant accepted the usage rights agreement */
  rightsAccepted: boolean;
};

/** Validates the form; `forActivation` adds the checks a live wall needs. Returns error messages. */
export function validateWall(f: WallForm, forActivation: boolean): string[] {
  const errors: string[] = [];
  if (!f.title.trim()) errors.push("Give the wall campaign a name.");
  if (f.title.trim().length > 80) errors.push("Keep the name under 80 characters.");
  if (forActivation && f.productScope === "SPECIFIC" && !f.products.length) errors.push("Pick at least one product, or choose “All products”.");
  if (forActivation && !f.moment.trim()) errors.push("Tell customers what to share.");
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  if (f.rewardType === "DISCOUNT_CODE") {
    const a = num(f.discountCodeAmount);
    if (a === null || !(a > 0)) errors.push("Enter a discount amount greater than 0.");
    else if (f.discountCodeType === "PERCENTAGE" && a > 100) errors.push("A percentage discount can't be more than 100%.");
    const m = num(f.discountCodeMinOrder);
    if (m !== null && !(m >= 0)) errors.push("Minimum order must be 0 or more.");
    const d = num(f.discountCodeExpiryDays);
    if (d !== null && !(Number.isInteger(d) && d >= 0 && d <= 3650)) errors.push("Code expiry must be a whole number of days, up to 3650 (0 = no expiry).");
  }
  if (f.rewardType === "STORE_CREDIT") {
    const a = num(f.storeCreditAmount);
    if (a === null || !(a > 0)) errors.push("Enter a store credit amount greater than 0.");
    else if (a > 10000) errors.push("Store credit can't be more than 10,000.");
    const d = num(f.storeCreditExpiryDays);
    if (d !== null && !(Number.isInteger(d) && d >= 0 && d <= 3650)) errors.push("Store credit expiry must be a whole number of days, up to 3650 (0 = no expiry).");
  }
  if (f.hasLimit) {
    const m = num(f.maxSubmissions);
    if (m === null || !(Number.isInteger(m) && m >= 1 && m <= 100000)) errors.push("Submission limit must be a whole number between 1 and 100,000.");
  }
  if (forActivation && !f.rightsAccepted) errors.push("Accept the usage rights agreement to activate the wall.");
  return errors;
}

