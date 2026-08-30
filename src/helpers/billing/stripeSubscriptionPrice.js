const cleanPriceId = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const finiteNonNegative = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export const getStripeSubscriptionPriceSnapshot = (
  stripeSubscription,
  {
    fallbackPriceMonthly = null,
    fallbackStripePriceId = "",
  } = {},
) => {
  const stripePrice = stripeSubscription?.items?.data?.[0]?.price || null;
  const unitAmountCents = finiteNonNegative(
    stripePrice?.unit_amount ?? stripePrice?.unit_amount_decimal,
  );
  const fallbackMonthly = finiteNonNegative(fallbackPriceMonthly);

  return {
    stripePriceId:
      cleanPriceId(stripePrice?.id) || cleanPriceId(fallbackStripePriceId),
    priceMonthly:
      unitAmountCents === null
        ? fallbackMonthly
        : unitAmountCents / 100,
  };
};

export default getStripeSubscriptionPriceSnapshot;
