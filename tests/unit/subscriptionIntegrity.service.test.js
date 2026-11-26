import {
  isStripeSubscriptionLive,
  listLiveStripeSubscriptions,
} from "../../src/services/subscriptionIntegrity.service.js";

describe("subscriptionIntegrity.service", () => {
  test.each([
    "incomplete",
    "trialing",
    "active",
    "past_due",
    "unpaid",
    "paused",
  ])("treats %s as a live Stripe subscription", (status) => {
    expect(isStripeSubscriptionLive(status)).toBe(true);
  });

  test.each(["canceled", "incomplete_expired", "expired", "none", ""])(
    "treats %s as terminal/non-live",
    (status) => {
      expect(isStripeSubscriptionLive(status)).toBe(false);
    },
  );

  test("lists all Stripe statuses and filters to live subscriptions", async () => {
    const stripe = {
      subscriptions: {
        list: jest.fn().mockResolvedValue({
          data: [
            { id: "sub_active", status: "active" },
            { id: "sub_trial", status: "trialing" },
            { id: "sub_canceled", status: "canceled" },
          ],
        }),
      },
    };

    const result = await listLiveStripeSubscriptions({
      stripe,
      stripeCustomerId: "cus_test",
    });

    expect(stripe.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus_test",
      status: "all",
      limit: 100,
    });
    expect(result.map((item) => item.id)).toEqual([
      "sub_active",
      "sub_trial",
    ]);
  });

  test("fails closed when Stripe subscription listing is unavailable", async () => {
    await expect(
      listLiveStripeSubscriptions({
        stripe: { subscriptions: {} },
        stripeCustomerId: "cus_test",
      }),
    ).rejects.toMatchObject({
      code: "STRIPE_SUBSCRIPTION_LIST_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
test('B07 provider listing errors never look like an empty inventory authorizing another subscription',async()=>{
 const error=Object.assign(new Error('synthetic Stripe timeout'),{code:'ETIMEDOUT'});
 const stripe={subscriptions:{list:jest.fn().mockRejectedValue(error)}};
 await expect(listLiveStripeSubscriptions({stripe,stripeCustomerId:'cus_synthetic'})).rejects.toBe(error);
 expect(stripe.subscriptions.list).toHaveBeenCalledTimes(1);
});
