const mockSubscriptionFindOne = jest.fn();
const mockBillingAnomalyFindOneAndUpdate = jest.fn();
const mockGetStripeClient = jest.fn();

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: mockSubscriptionFindOne,
  },
}));

jest.mock("../../src/models/billingAnomaly.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: mockBillingAnomalyFindOneAndUpdate,
  },
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: mockGetStripeClient,
}));

const {
  guardCanonicalStripeSubscription,
  guardInvoiceAgainstCanonicalSubscription,
} = require("../../src/services/subscriptionIntegrity.service.js");

describe("subscription integrity ordering and invoice guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingAnomalyFindOneAndUpdate.mockResolvedValue({ _id: "anomaly-1" });
  });

  test("rejects a competing live subscription while canonical is live", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "business-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-A",
      status: "active",
    });
    const stripe = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({ id: "sub-A", status: "active" }),
      },
    };

    const result = await guardCanonicalStripeSubscription({
      stripe,
      businessId: "business-1",
      incomingStripeSubscription: {
        id: "sub-B",
        customer: "cus-1",
        status: "active",
      },
    });

    expect(result.allowed).toBe(false);
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: expect.stringContaining("competing-webhook"),
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  test("allows a new live subscription to replace a missing terminal canonical", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "business-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-old",
      status: "canceled",
    });
    const missing = Object.assign(new Error("not found"), {
      code: "resource_missing",
      statusCode: 404,
    });
    const stripe = {
      subscriptions: {
        retrieve: jest.fn().mockRejectedValue(missing),
      },
    };

    const result = await guardCanonicalStripeSubscription({
      stripe,
      businessId: "business-1",
      incomingStripeSubscription: {
        id: "sub-new",
        customer: "cus-1",
        status: "active",
      },
    });

    expect(result.allowed).toBe(true);
  });

  test("rejects a late foreign terminal webhook when canonical is already terminal/missing", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "business-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-old",
      status: "canceled",
    });
    const stripe = {
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: "sub-old",
          status: "canceled",
        }),
      },
    };

    const result = await guardCanonicalStripeSubscription({
      stripe,
      businessId: "business-1",
      incomingStripeSubscription: {
        id: "sub-older",
        customer: "cus-1",
        status: "canceled",
      },
    });

    expect(result.allowed).toBe(false);
  });

  test("blocks an invoice attached to a noncanonical subscription", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "business-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-A",
    });

    const result = await guardInvoiceAgainstCanonicalSubscription({
      invoice: {
        id: "in-1",
        customer: "cus-1",
        subscription: "sub-B",
        billing_reason: "subscription_cycle",
        amount_due: 19900,
      },
      eventId: "evt-1",
    });

    expect(result.allowed).toBe(false);
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test("allows the canonical invoice but records paid subscription_update as an anomaly", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "business-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-A",
    });

    const result = await guardInvoiceAgainstCanonicalSubscription({
      invoice: {
        id: "in-update",
        customer: "cus-1",
        subscription: "sub-A",
        billing_reason: "subscription_update",
        amount_paid: 19900,
      },
      eventId: "evt-update",
    });

    expect(result.allowed).toBe(true);
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });
});
