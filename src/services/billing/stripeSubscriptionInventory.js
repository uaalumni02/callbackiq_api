import { numericSetting } from "../../config/numericSettings.js";
/** Lists the complete bounded customer inventory; incomplete pagination blocks new billing. */
export async function readStripeSubscriptionInventory(stripe, customerId) {
  const rows = [];
  let after;
  for (
    let page = 0;
    page < numericSetting("PILOT_STRIPE_SUBSCRIPTION_SCAN_PAGES");
    page++
  ) {
    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    if (!Array.isArray(result?.data))
      throw Object.assign(
        new Error("Stripe subscription inventory could not be verified."),
        { code: "STRIPE_INVENTORY_UNVERIFIED", statusCode: 503 },
      );
    rows.push(...result.data);
    if (!result.has_more) return rows;
    const next = result.data.at(-1)?.id;
    if (!next || next === after) break;
    after = next;
  }
  throw Object.assign(
    new Error("Billing inventory requires operator reconciliation."),
    { code: "STRIPE_INVENTORY_INCOMPLETE", statusCode: 409 },
  );
}
