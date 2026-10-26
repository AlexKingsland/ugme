/**
 * Shopify discount codes for DISCOUNT_CODE campaigns.
 *
 * Each approved submission gets its own single-use code, restricted to the
 * submitting customer, created through the Admin GraphQL API
 * (needs the `write_discounts` scope).
 */
import type { AdminGraphqlClient } from "./providers";

export interface RewardCodeInput {
  code: string;
  title: string;
  shopifyCustomerId: string; // numeric or GID
  valueType: "PERCENTAGE" | "FIXED_AMOUNT";
  amount: number;
  endsAt: Date | null;
  minimumSubtotal: number | null;
}

export interface CreatedRewardCode {
  id: string;
  code: string;
  reused: boolean;
}

export class DiscountCodeError extends Error {}

function customerGid(id: string) {
  return id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`;
}

/** Deterministic, human-friendly code: WALL-SUMMERRUN-7F3K2Q */
export function rewardCodeFor(campaignTitle: string, submissionId: string) {
  const slug = campaignTitle.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase() || "REWARD";
  return `WALL-${slug}-${submissionId.slice(-6).toUpperCase()}`;
}

async function gql(admin: AdminGraphqlClient, query: string, variables: Record<string, unknown>) {
  const res = await admin.graphql(query, { variables });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    const msg = body.errors?.map((e: any) => e.message).join("; ") || `HTTP ${res.status}`;
    if (/access denied|write_discounts|scope/i.test(msg)) {
      throw new DiscountCodeError("App is missing the write_discounts permission — re-approve the app in Shopify admin.");
    }
    throw new DiscountCodeError(`Shopify API error: ${msg}`);
  }
  return body.data;
}

async function findExistingCode(admin: AdminGraphqlClient, code: string): Promise<string | null> {
  const data = await gql(
    admin,
    `#graphql
    query UgmeFindRewardCode($code: String!) {
      codeDiscountNodeByCode(code: $code) { id }
    }`,
    { code },
  );
  return data?.codeDiscountNodeByCode?.id ?? null;
}

/**
 * Create the customer's reward code. Idempotent: if the code already exists
 * (e.g. a previous attempt succeeded on Shopify but we failed to record it),
 * the existing discount is reused.
 */
export async function createCustomerDiscountCode(admin: AdminGraphqlClient, input: RewardCodeInput): Promise<CreatedRewardCode> {
  const existingId = await findExistingCode(admin, input.code);
  if (existingId) return { id: existingId, code: input.code, reused: true };

  const value =
    input.valueType === "PERCENTAGE"
      ? { percentage: Math.min(100, Math.max(0, input.amount)) / 100 }
      : { discountAmount: { amount: input.amount.toFixed(2), appliesOnEachItem: false } };

  const data = await gql(
    admin,
    `#graphql
    mutation UgmeCreateRewardCode($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        title: input.title.slice(0, 255),
        code: input.code,
        startsAt: new Date().toISOString(),
        endsAt: input.endsAt ? input.endsAt.toISOString() : null,
        customerSelection: { customers: { add: [customerGid(input.shopifyCustomerId)] } },
        customerGets: { value, items: { all: true } },
        minimumRequirement: input.minimumSubtotal
          ? { subtotal: { greaterThanOrEqualToSubtotal: input.minimumSubtotal.toFixed(2) } }
          : null,
        usageLimit: 1,
        appliesOncePerCustomer: true,
      },
    },
  );

  const result = data?.discountCodeBasicCreate;
  const errors: { message: string; code?: string }[] = result?.userErrors ?? [];
  if (errors.length) {
    // Lost a race / earlier attempt created it — reuse
    if (errors.some((e) => e.code === "TAKEN" || /unique/i.test(e.message))) {
      const id = await findExistingCode(admin, input.code);
      if (id) return { id, code: input.code, reused: true };
    }
    throw new DiscountCodeError(`Shopify rejected the discount: ${errors.map((e) => e.message).join("; ")}`);
  }
  const id = result?.codeDiscountNode?.id;
  if (!id) throw new DiscountCodeError("Shopify did not return the created discount");
  return { id, code: input.code, reused: false };
}
