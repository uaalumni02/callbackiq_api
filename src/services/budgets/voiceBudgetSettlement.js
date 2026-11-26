import { settleProviderBudget } from "./providerBudget.service.js";
/** Allocates verified call usage across reservations in their original periods; repeated receipts are inert. */
export async function settleVoiceBudgetReservations({
  businessId,
  reservations,
  actualSeconds,
  mongoSession,
}) {
  let remaining = Math.max(0, Math.round(actualSeconds));
  for (let index = 0; index < reservations.length; index++) {
    const reservation = reservations[index];
    const amount =
      index === reservations.length - 1
        ? remaining
        : Math.min(remaining, reservation.requestedSeconds);
    await settleProviderBudget({
      businessId,
      metric: "voice",
      key: reservation.reservationKey,
      actualAmount: amount,
      mongoSession,
    });
    remaining = Math.max(0, remaining - amount);
  }
}
