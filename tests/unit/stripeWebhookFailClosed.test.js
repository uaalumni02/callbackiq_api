jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  __esModule: true,
  getStripeClient: jest.fn(() => ({
    webhooks: {
      constructEvent: jest.fn(),
    },
  })),
  getPriceIdByPlan: jest.fn(),
}));

import BillingController from "../../src/controllers/billing.js";

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("Stripe webhook fail-closed behavior", () => {
  const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
  });

  test("refuses webhook processing when the signing secret is absent", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = makeRes();

    await BillingController.handleStripeWebhook(
      {
        headers: { "stripe-signature": "sig_test" },
        body: Buffer.from('{"type":"invoice.paid"}'),
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
  });

  test("refuses webhook processing when the Stripe signature is absent", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const res = makeRes();

    await BillingController.handleStripeWebhook(
      {
        headers: {},
        body: Buffer.from('{"type":"invoice.paid"}'),
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
