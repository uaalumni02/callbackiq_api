import { readStripeSubscriptionInventory } from "../../src/services/billing/stripeSubscriptionInventory.js";
import { assertPilotPortalConfiguration } from "../../src/services/billing/pilotPortalPolicy.js";
test("B07 subscription verification follows pages and fails closed on incomplete inventory", async () => {
  const stripe = {
    subscriptions: {
      list: jest
        .fn()
        .mockResolvedValueOnce({ data: [{ id: "canceled" }], has_more: true })
        .mockResolvedValueOnce({
          data: [{ id: "active", status: "active" }],
          has_more: false,
        }),
    },
  };
  expect(
    await readStripeSubscriptionInventory(stripe, "cus_pilot"),
  ).toHaveLength(2);
  expect(stripe.subscriptions.list.mock.calls[1][0].starting_after).toBe(
    "canceled",
  );
  stripe.subscriptions.list.mockResolvedValue({ data: [], has_more: true });
  await expect(
    readStripeSubscriptionInventory(stripe, "cus_pilot"),
  ).rejects.toMatchObject({ code: "STRIPE_INVENTORY_INCOMPLETE" });
});
test("B07 a portal cannot enable plan or quantity changes", async () => {
  const stripe = {
    billingPortal: {
      configurations: {
        retrieve: jest.fn(async () => ({
          active: true,
          features: { subscription_update: { enabled: true } },
        })),
      },
    },
  };
  await expect(
    assertPilotPortalConfiguration(stripe, "bpc_pilot"),
  ).rejects.toMatchObject({ code: "PORTAL_CONFIGURATION_UNSAFE" });
  stripe.billingPortal.configurations.retrieve.mockResolvedValue({
    active: true,
    features: { subscription_update: { enabled: false } },
  });
  await expect(
    assertPilotPortalConfiguration(stripe, "bpc_pilot"),
  ).resolves.toMatchObject({ active: true });
});
