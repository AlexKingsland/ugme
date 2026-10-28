/**
 * Store credit rewards — credited to the customer's Shopify store credit
 * account (Shopify holds the balance; we never keep a ledger).
 * Needs the `write_store_credit_account_transactions` scope.
 */
import type { AdminGraphqlClient } from "./providers";

export class StoreCreditError extends Error {
  /** true when we can't tell whether Shopify applied the credit (e.g. network error) */
  constructor(message: string, readonly uncertain = false) {
    super(message);
  }
}

export interface CreditResult {
  transactionId: string | null;
  amount: number;
  currencyCode: string;
}

export async function creditStoreCredit(
  admin: AdminGraphqlClient,
  input: { shopifyCustomerId: string; amount: number; expiresAt: Date | null },
): Promise<CreditResult> {
  const customerId = input.shopifyCustomerId.startsWith("gid://")
    ? input.shopifyCustomerId
    : `gid://shopify/Customer/${input.shopifyCustomerId}`;

  // Credit in the shop's currency
  const shopRes = await admin.graphql(`#graphql
    query WallShopCurrency { shop { currencyCode } }`);
  const shopBody: any = await shopRes.json().catch(() => ({}));
  const currencyCode: string | undefined = shopBody?.data?.shop?.currencyCode;
  if (!currencyCode) throw new StoreCreditError(`Couldn't read the shop currency${shopBody?.errors ? `: ${JSON.stringify(shopBody.errors).slice(0, 200)}` : ""}`);

  let body: any;
  try {
    const res = await admin.graphql(
      `#graphql
      mutation WallStoreCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
          storeCreditAccountTransaction { amount { amount currencyCode } }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          id: customerId,
          creditInput: {
            creditAmount: { amount: input.amount.toFixed(2), currencyCode },
            ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
          },
        },
      },
    );
    body = await res.json();
  } catch (err: any) {
    // The app's Admin client throws when Shopify answers with GraphQL errors.
    const gqlErrors = err?.body?.errors?.graphQLErrors ?? err?.graphQLErrors;
    if (Array.isArray(gqlErrors) && gqlErrors.length) {
      const msg = gqlErrors.map((e: any) => e.message).join("; ");
      // Shopify still runs a mutation when only a *returned* field is denied,
      // so treat field-access errors as "may have been applied".
      const fieldDenied = gqlErrors.some((e: any) => /access denied/i.test(e.message) && (e.path?.length ?? 0) > 1);
      throw new StoreCreditError(`Store credit failed: ${msg}`, fieldDenied);
    }
    // The request may or may not have reached Shopify — don't blindly retry.
    throw new StoreCreditError(`Store credit request failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }

  if (body?.errors?.length) {
    const msg = body.errors.map((e: any) => e.message).join("; ");
    throw new StoreCreditError(
      /access|scope|denied/i.test(msg)
        ? `Store credit permission missing — re-approve the app's permissions (${msg})`
        : `Store credit failed: ${msg}`,
    );
  }
  const payload = body?.data?.storeCreditAccountCredit;
  if (payload?.userErrors?.length) {
    throw new StoreCreditError(`Store credit rejected: ${payload.userErrors.map((e: any) => e.message).join("; ")}`);
  }
  const tx = payload?.storeCreditAccountTransaction;
  if (!tx) throw new StoreCreditError("Store credit returned no transaction", true);
  return {
    transactionId: null,
    amount: Number(tx.amount?.amount ?? input.amount),
    currencyCode: tx.amount?.currencyCode ?? currencyCode,
  };
}


/**
 * Did this customer receive a store credit of `amount` since `since`?
 * Used to resolve "uncertain" attempts (request may have reached Shopify)
 * without ever crediting twice. Needs `read_store_credit_accounts`.
 * Returns null when Shopify can't be asked (e.g. permission not approved yet).
 */
export async function findRecentStoreCredit(
  admin: AdminGraphqlClient,
  input: { shopifyCustomerId: string; amount: number; since: Date },
): Promise<boolean | null> {
  const customerId = input.shopifyCustomerId.startsWith("gid://")
    ? input.shopifyCustomerId
    : `gid://shopify/Customer/${input.shopifyCustomerId}`;
  try {
    const res = await admin.graphql(
      `#graphql
      query WallStoreCreditCheck($id: ID!) {
        customer(id: $id) {
          storeCreditAccounts(first: 10) {
            nodes { transactions(first: 50, reverse: true) { nodes { __typename amount { amount } createdAt } } }
          }
        }
      }`,
      { variables: { id: customerId } },
    );
    const body: any = await res.json();
    if (body?.errors?.length) return null;
    const since = input.since.getTime();
    for (const account of body?.data?.customer?.storeCreditAccounts?.nodes ?? []) {
      for (const t of account?.transactions?.nodes ?? []) {
        const amt = Number(t?.amount?.amount);
        if (Math.abs(amt - input.amount) < 0.005 && new Date(t.createdAt).getTime() >= since && !/Debit/.test(t.__typename || "")) return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}
