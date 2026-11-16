import { date, inRange } from './reportingPolicy.js';
export const invoiceTotals = (facts, start, end) => {
  const live = facts.filter((f) => f.livemode === true && f.currency === "usd");
  const cashCents = live
    .filter((f) => inRange(f.paidAt, start, end))
    .reduce((s, f) => s + (f.amountPaidCents || 0), 0);
  // A management allocation of paid recurring invoice amounts, not GAAP revenue.
  let allocatedCents = 0,
    allocationComplete = true;
  for (const f of live) {
    const a = date(f.periodStart),
      b = date(f.periodEnd);
    if (f.status !== "paid" || !f.recurring) continue;
    if (!a || !b || b <= a || f.allocatableCents == null) {
      allocationComplete = false;
      continue;
    }
    const overlap = Math.max(0, Math.min(+b, +end) - Math.max(+a, +start));
    allocatedCents += (f.allocatableCents * overlap) / (b - a);
  }
  return {
    cashCents,
    allocatedCents: allocationComplete ? Math.round(allocatedCents) : null,
    overdueCents: live
      .filter(
        (f) => f.status === "open" && date(f.dueAt) && date(f.dueAt) < end,
      )
      .reduce((s, f) => s + (f.amountRemainingCents || 0), 0),
  };
};
