import Stripe from "stripe";

let stripeClient = null;
let cachedSecretKey = "";

const getStripeClient = () => {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is missing");
  }

  /*
   * Initialize lazily so tests can configure or mock the environment after
   * importing this module.
   */
  if (!stripeClient || secretKey !== cachedSecretKey) {
    stripeClient = new Stripe(secretKey);
    cachedSecretKey = secretKey;
  }

  return stripeClient;
};

const getPriceIdByPlan = (plan) => {
  const normalizedPlan = String(plan || "")
    .trim()
    .toLowerCase();

  const priceMap = {
    starter: process.env.STRIPE_STARTER_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
    agency: process.env.STRIPE_AGENCY_PRICE_ID,
  };

  const priceId = priceMap[normalizedPlan];

  return typeof priceId === "string" && priceId.trim()
    ? priceId.trim()
    : undefined;
};

const formatStripeMoney = (amount = 0, currency = "usd") => {
  const numericAmount = Number(amount);
  const value = Number.isFinite(numericAmount) ? numericAmount / 100 : 0;
  const normalizedCurrency = String(currency || "usd").toUpperCase();

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
    }).format(value);
  } catch {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  }
};

const resetStripeClient = () => {
  stripeClient = null;
  cachedSecretKey = "";
};

export {
  getStripeClient,
  getPriceIdByPlan,
  formatStripeMoney,
  resetStripeClient,
};
