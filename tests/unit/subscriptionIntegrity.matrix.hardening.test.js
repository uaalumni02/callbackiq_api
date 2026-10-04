const mockSubscriptionFindOne = jest.fn();
const mockSubscriptionFind = jest.fn();
const mockBillingAnomalyFindOneAndUpdate = jest.fn();
const mockGetStripeClient = jest.fn();

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: mockSubscriptionFindOne,
    find: mockSubscriptionFind,
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
  LIVE_STRIPE_SUBSCRIPTION_STATUSES,
  isStripeSubscriptionLive,
  recordBillingAnomaly,
  listLiveStripeSubscriptions,
  findExistingStripeCustomerForBusiness,
  assertStripeCustomerHasNoCompetingSubscriptions,
  assertCanonicalIsOnlyLiveSubscription,
  guardCanonicalStripeSubscription,
  guardInvoiceAgainstCanonicalSubscription,
  reconcileStripeSubscriptionIntegrity,
} = require("../../src/services/subscriptionIntegrity.service.js");

const live = (id, status = "active") => ({ id, status });

const expectCode = async (promise, code, statusCode) => {
  await expect(promise).rejects.toMatchObject({ code, statusCode });
};

describe("subscriptionIntegrity.service adversarial matrix", () => {
  let consoleError;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockBillingAnomalyFindOneAndUpdate.mockResolvedValue({ _id: "anomaly-1" });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test("recognizes every live Stripe status and rejects terminal/unknown values", () => {
    expect(LIVE_STRIPE_SUBSCRIPTION_STATUSES).toEqual(
      expect.arrayContaining([
        "incomplete",
        "trialing",
        "active",
        "past_due",
        "unpaid",
        "paused",
      ]),
    );

    for (const status of LIVE_STRIPE_SUBSCRIPTION_STATUSES) {
      expect(isStripeSubscriptionLive(status)).toBe(true);
      expect(isStripeSubscriptionLive({ status: status.toUpperCase() })).toBe(true);
    }

    for (const status of ["canceled", "incomplete_expired", "ended", "", null]) {
      expect(isStripeSubscriptionLive(status)).toBe(false);
    }
  });

  test("recordBillingAnomaly is a safe no-op without required identity", async () => {
    await expect(recordBillingAnomaly({ dedupeKey: "x" })).resolves.toBeNull();
    await expect(recordBillingAnomaly({ type: "x" })).resolves.toBeNull();
    expect(mockBillingAnomalyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("recordBillingAnomaly serializes safe details, counts occurrences and returns persistence result", async () => {
    const persisted = { _id: "anomaly-2", occurrences: 2 };
    mockBillingAnomalyFindOneAndUpdate.mockResolvedValue(persisted);

    const result = await recordBillingAnomaly({
      businessId: "biz-1",
      type: "duplicate_subscription",
      stripeCustomerId: "cus-1",
      canonicalSubscriptionId: "sub-a",
      observedSubscriptionId: "sub-b",
      invoiceId: "in-1",
      eventId: "evt-1",
      source: "test",
      dedupeKey: "dedupe-1",
      details: { nested: { ok: true } },
    });

    expect(result).toBe(persisted);
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalledWith(
      { dedupeKey: "dedupe-1" },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ dedupeKey: "dedupe-1" }),
        $set: expect.objectContaining({
          business: "biz-1",
          type: "duplicate_subscription",
          status: "open",
          details: { nested: { ok: true } },
        }),
        $inc: { occurrences: 1 },
      }),
      expect.objectContaining({ upsert: true, runValidators: true }),
    );
  });

  test("recordBillingAnomaly handles circular details and persistence failure without weakening the guard", async () => {
    const circular = {};
    circular.self = circular;
    mockBillingAnomalyFindOneAndUpdate.mockRejectedValueOnce(new Error("mongo unavailable"));

    await expect(
      recordBillingAnomaly({
        type: "serialization_test",
        dedupeKey: "circular",
        details: circular,
      }),
    ).resolves.toBeNull();

    const update = mockBillingAnomalyFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.details).toEqual({
      note: "Billing anomaly details could not be serialized.",
    });
    expect(consoleError).toHaveBeenCalled();
  });

  test("listLiveStripeSubscriptions short-circuits without customer and fails closed without Stripe list API", async () => {
    await expect(
      listLiveStripeSubscriptions({ stripe: {}, stripeCustomerId: "" }),
    ).resolves.toEqual([]);

    await expectCode(
      listLiveStripeSubscriptions({ stripe: {}, stripeCustomerId: "cus-1" }),
      "STRIPE_SUBSCRIPTION_LIST_UNAVAILABLE",
      503,
    );
  });

  test("listLiveStripeSubscriptions requests all subscriptions and filters terminal states", async () => {
    const stripe = {
      subscriptions: {
        list: jest.fn().mockResolvedValue({
          data: [
            live("sub-active", "active"),
            live("sub-trial", "trialing"),
            live("sub-canceled", "canceled"),
          ],
        }),
      },
    };

    await expect(
      listLiveStripeSubscriptions({ stripe, stripeCustomerId: "cus-1" }),
    ).resolves.toEqual([
      live("sub-active", "active"),
      live("sub-trial", "trialing"),
    ]);
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus-1",
      status: "all",
      limit: 100,
    });
  });

  test("listLiveStripeSubscriptions tolerates malformed Stripe list payload", async () => {
    const stripe = { subscriptions: { list: jest.fn().mockResolvedValue({ data: null }) } };
    await expect(
      listLiveStripeSubscriptions({ stripe, stripeCustomerId: "cus-1" }),
    ).resolves.toEqual([]);
  });

  test("findExistingStripeCustomerForBusiness returns null when search cannot be performed", async () => {
    await expect(
      findExistingStripeCustomerForBusiness({ stripe: {}, businessId: "biz-1" }),
    ).resolves.toBeNull();
    await expect(
      findExistingStripeCustomerForBusiness({
        stripe: { customers: { search: jest.fn() } },
        businessId: "",
      }),
    ).resolves.toBeNull();
  });

  test("findExistingStripeCustomerForBusiness ignores false-positive metadata matches", async () => {
    const stripe = {
      customers: {
        search: jest.fn().mockResolvedValue({
          data: [
            { id: "cus-wrong", metadata: { businessId: "other" } },
            { id: "cus-right", metadata: { businessId: "biz-1" } },
          ],
        }),
      },
    };

    await expect(
      findExistingStripeCustomerForBusiness({ stripe, businessId: "biz-1" }),
    ).resolves.toEqual({ id: "cus-right", metadata: { businessId: "biz-1" } });
    expect(stripe.customers.search).toHaveBeenCalledWith({
      query: "metadata['businessId']:'biz-1'",
      limit: 10,
    });
  });

  test("findExistingStripeCustomerForBusiness blocks multiple exact customers and records anomaly", async () => {
    const stripe = {
      customers: {
        search: jest.fn().mockResolvedValue({
          data: [
            { id: "cus-a", metadata: { businessId: "biz-1" } },
            { id: "cus-b", metadata: { businessId: "biz-1" } },
          ],
        }),
      },
    };

    await expectCode(
      findExistingStripeCustomerForBusiness({ stripe, businessId: "biz-1" }),
      "MULTIPLE_STRIPE_CUSTOMERS",
      409,
    );
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test("checkout preflight returns cleanly when Stripe has no live subscription", async () => {
    const stripe = { subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) } };
    await expect(
      assertStripeCustomerHasNoCompetingSubscriptions({
        stripe,
        business: { _id: "biz-1" },
        stripeCustomerId: "cus-1",
      }),
    ).resolves.toEqual([]);
  });

  test("checkout preflight blocks one existing live subscription", async () => {
    const stripe = {
      subscriptions: { list: jest.fn().mockResolvedValue({ data: [live("sub-a")] }) },
    };

    await expectCode(
      assertStripeCustomerHasNoCompetingSubscriptions({
        stripe,
        business: "biz-1",
        existingSubscription: { stripeSubscriptionId: "sub-a" },
        stripeCustomerId: "cus-1",
      }),
      "STRIPE_SUBSCRIPTION_ALREADY_EXISTS",
      409,
    );
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test("checkout preflight blocks multiple live subscriptions with stable sorted dedupe identity", async () => {
    const stripe = {
      subscriptions: {
        list: jest.fn().mockResolvedValue({ data: [live("sub-z"), live("sub-a")] }),
      },
    };

    await expectCode(
      assertStripeCustomerHasNoCompetingSubscriptions({
        stripe,
        business: { _id: "biz-1" },
        stripeCustomerId: "cus-1",
      }),
      "DUPLICATE_STRIPE_SUBSCRIPTIONS",
      409,
    );

    const update = mockBillingAnomalyFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.observedSubscriptionId).toBe("sub-z,sub-a");
    expect(mockBillingAnomalyFindOneAndUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ dedupeKey: expect.stringContaining("sub-a|sub-z") }),
    );
  });

  test("canonical action requires both Stripe customer and subscription ids", async () => {
    await expectCode(
      assertCanonicalIsOnlyLiveSubscription({ stripe: {}, subscription: {} }),
      "CANONICAL_STRIPE_SUBSCRIPTION_REQUIRED",
      409,
    );
  });

  test("canonical action returns the sole live canonical subscription", async () => {
    const stripe = {
      subscriptions: {
        list: jest.fn().mockResolvedValue({ data: [live("sub-a", "trialing")] }),
      },
    };
    const local = {
      business: "biz-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-a",
    };

    await expect(
      assertCanonicalIsOnlyLiveSubscription({ stripe, subscription: local }),
    ).resolves.toEqual(live("sub-a", "trialing"));
  });

  test("canonical action blocks any competing live subscription", async () => {
    const stripe = {
      subscriptions: {
        list: jest.fn().mockResolvedValue({ data: [live("sub-a"), live("sub-b")] }),
      },
    };

    await expectCode(
      assertCanonicalIsOnlyLiveSubscription({
        stripe,
        subscription: {
          business: "biz-1",
          stripeCustomerId: "cus-1",
          stripeSubscriptionId: "sub-a",
        },
        source: "cancel",
      }),
      "DUPLICATE_STRIPE_SUBSCRIPTIONS",
      409,
    );
  });

  test("canonical action blocks when tracked canonical is no longer live", async () => {
    const stripe = {
      subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
    };

    await expectCode(
      assertCanonicalIsOnlyLiveSubscription({
        stripe,
        subscription: {
          business: "biz-1",
          stripeCustomerId: "cus-1",
          stripeSubscriptionId: "sub-a",
        },
      }),
      "CANONICAL_STRIPE_SUBSCRIPTION_NOT_LIVE",
      409,
    );
  });

  test("webhook guard allows events with insufficient identity and same canonical id", async () => {
    await expect(
      guardCanonicalStripeSubscription({
        stripe: {},
        businessId: "",
        incomingStripeSubscription: { id: "sub-a" },
      }),
    ).resolves.toEqual({ allowed: true, current: null });

    mockSubscriptionFindOne.mockResolvedValue({ stripeSubscriptionId: "sub-a" });
    await expect(
      guardCanonicalStripeSubscription({
        stripe: {},
        businessId: "biz-1",
        incomingStripeSubscription: { id: "sub-a", status: "active" },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  test("webhook guard allows first Stripe subscription when local canonical is absent", async () => {
    mockSubscriptionFindOne.mockResolvedValue({ business: "biz-1", stripeSubscriptionId: "" });
    await expect(
      guardCanonicalStripeSubscription({
        stripe: {},
        businessId: "biz-1",
        incomingStripeSubscription: { id: "sub-new", status: "active" },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  test("webhook guard permits a new live subscription only after canonical is terminal/missing", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-old",
      status: "canceled",
    });
    const missing = Object.assign(new Error("missing"), {
      code: "resource_missing",
      statusCode: 404,
    });
    const stripe = { subscriptions: { retrieve: jest.fn().mockRejectedValue(missing) } };

    await expect(
      guardCanonicalStripeSubscription({
        stripe,
        businessId: "biz-1",
        incomingStripeSubscription: { id: "sub-new", status: "active", customer: "cus-1" },
      }),
    ).resolves.toMatchObject({ allowed: true, canonical: null });
  });

  test("webhook guard rejects foreign terminal event when canonical is missing", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-old",
    });
    const stripe = {
      subscriptions: {
        retrieve: jest.fn().mockRejectedValue(Object.assign(new Error("missing"), { statusCode: 404 })),
      },
    };

    await expect(
      guardCanonicalStripeSubscription({
        stripe,
        businessId: "biz-1",
        incomingStripeSubscription: { id: "sub-foreign", status: "canceled", customer: { id: "cus-1" } },
      }),
    ).resolves.toMatchObject({ allowed: false, canonical: null });
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test("webhook guard propagates unexpected Stripe retrieve failures", async () => {
    mockSubscriptionFindOne.mockResolvedValue({ stripeSubscriptionId: "sub-a" });
    const stripe = {
      subscriptions: { retrieve: jest.fn().mockRejectedValue(new Error("stripe down")) },
    };
    await expect(
      guardCanonicalStripeSubscription({
        stripe,
        businessId: "biz-1",
        incomingStripeSubscription: { id: "sub-b", status: "active" },
      }),
    ).rejects.toThrow("stripe down");
  });

  test("webhook guard rejects any competing event while canonical remains live", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-a",
    });
    const stripe = {
      subscriptions: { retrieve: jest.fn().mockResolvedValue(live("sub-a", "past_due")) },
    };

    await expect(
      guardCanonicalStripeSubscription({
        stripe,
        businessId: "biz-1",
        incomingStripeSubscription: { id: "sub-b", status: "canceled", customer: "cus-1" },
      }),
    ).resolves.toMatchObject({ allowed: false, canonical: live("sub-a", "past_due") });
  });

  test("invoice guard rejects invoice without a subscription reference", async () => {
    await expect(
      guardInvoiceAgainstCanonicalSubscription({ invoice: { id: "in-1" } }),
    ).resolves.toEqual({ allowed: false, subscription: null });
  });

  test("invoice guard falls back to lookup by observed subscription when customer is absent", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeSubscriptionId: "sub-a",
    });
    await expect(
      guardInvoiceAgainstCanonicalSubscription({
        invoice: { id: "in-1", subscription: "sub-a" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({ stripeSubscriptionId: "sub-a" });
  });

  test("invoice guard permits invoice when no canonical subscription exists locally", async () => {
    mockSubscriptionFindOne.mockResolvedValue({ business: "biz-1", stripeSubscriptionId: "" });
    await expect(
      guardInvoiceAgainstCanonicalSubscription({
        invoice: { id: "in-1", customer: "cus-1", subscription: "sub-new" },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  test("invoice guard blocks noncanonical subscription and records money context", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-a",
    });
    await expect(
      guardInvoiceAgainstCanonicalSubscription({
        invoice: {
          id: "in-1",
          customer: "cus-1",
          subscription: "sub-b",
          billing_reason: "subscription_cycle",
          amount_paid: 9900,
          amount_due: 9900,
        },
        eventId: "evt-1",
      }),
    ).resolves.toMatchObject({ allowed: false });
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test.each(["sub-b", { id: "sub-b" }])("modern invoice cannot bypass canonical subscription guard: %p", async subscription => {
    mockSubscriptionFindOne.mockResolvedValue({ business: "biz-1", stripeCustomerId: "cus-1", stripeSubscriptionId: "sub-a" });
    await expect(guardInvoiceAgainstCanonicalSubscription({ invoice: {
      id: "in-modern", customer: "cus-1", parent: { subscription_details: { subscription } },
    } })).resolves.toMatchObject({ allowed: false });
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test("invoice guard permits canonical invoice and flags paid subscription_update using amount_due fallback", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeCustomerId: "cus-1",
      stripeSubscriptionId: "sub-a",
    });

    await expect(
      guardInvoiceAgainstCanonicalSubscription({
        invoice: {
          id: "in-update",
          customer: { id: "cus-1" },
          subscription: { id: "sub-a" },
          billing_reason: "subscription_update",
          amount_paid: 0,
          amount_due: 2500,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalled();
  });

  test("invoice guard does not create anomaly for ordinary canonical zero-dollar invoice", async () => {
    mockSubscriptionFindOne.mockResolvedValue({
      business: "biz-1",
      stripeSubscriptionId: "sub-a",
    });
    mockBillingAnomalyFindOneAndUpdate.mockClear();

    await expect(
      guardInvoiceAgainstCanonicalSubscription({
        invoice: {
          id: "in-normal",
          subscription: "sub-a",
          billing_reason: "subscription_cycle",
          amount_due: 0,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
    expect(mockBillingAnomalyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("reconciliation fails closed when Stripe list API is unavailable", async () => {
    await expectCode(
      reconcileStripeSubscriptionIntegrity({ stripe: {} }),
      "STRIPE_SUBSCRIPTION_LIST_UNAVAILABLE",
      503,
    );
  });

  test("reconciliation classifies duplicate, mismatch, missing, clean, terminal and error cases", async () => {
    const locals = [
      { business: "biz-dup", stripeCustomerId: "cus-dup", stripeSubscriptionId: "sub-a", status: "active" },
      { business: "biz-mismatch", stripeCustomerId: "cus-mismatch", stripeSubscriptionId: "sub-old", status: "active" },
      { business: "biz-missing", stripeCustomerId: "cus-missing", stripeSubscriptionId: "sub-missing", status: "trialing" },
      { business: "biz-clean", stripeCustomerId: "cus-clean", stripeSubscriptionId: "sub-clean", status: "active" },
      { business: "biz-terminal", stripeCustomerId: "cus-terminal", stripeSubscriptionId: "sub-terminal", status: "canceled" },
      { business: "biz-error", stripeCustomerId: "cus-error", stripeSubscriptionId: "sub-error", status: "active" },
    ];
    mockSubscriptionFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(locals) });

    const stripe = {
      subscriptions: {
        list: jest.fn().mockImplementation(async ({ customer }) => {
          if (customer === "cus-dup") return { data: [live("sub-a"), live("sub-b")] };
          if (customer === "cus-mismatch") return { data: [live("sub-new")] };
          if (customer === "cus-missing") return { data: [] };
          if (customer === "cus-clean") return { data: [live("sub-clean")] };
          if (customer === "cus-terminal") return { data: [] };
          throw new Error("stripe list failed");
        }),
      },
    };

    await expect(reconcileStripeSubscriptionIntegrity({ stripe })).resolves.toEqual({
      scanned: 6,
      clean: 2,
      anomalies: 3,
      multipleLive: 1,
      canonicalMismatch: 1,
      canonicalMissing: 1,
      errors: 1,
    });
    expect(mockBillingAnomalyFindOneAndUpdate).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalled();
  });
});
