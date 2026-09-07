import {
  fetchTwilioExpense,
  fetchStripeExpense,
  fetchOpenAiExpense,
  monthRange,
  stripeTransactionFee,
} from "../../src/services/admin/companyExpenses.service.js";
const range = monthRange("2026-09", new Date("2026-09-07T20:00:00Z"));
test("Twilio uses totalprice once instead of double-counting overlapping categories", async () => {
  const client = {
    usage: {
      records: {
        list: jest
          .fn()
          .mockResolvedValue([
            {
              category: "totalprice",
              price: "12.345",
              priceUnit: "usd",
              asOf: "2026-09-07",
            },
          ]),
      },
    },
  };
  expect((await fetchTwilioExpense(client, range)).amountCents).toBe(1235);
  expect(client.usage.records.list).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "totalprice",
      includeSubaccounts: true,
    }),
  );
});
test("Stripe processes every page and keeps fee credits signed", async () => {
  const client = {
    balanceTransactions: {
      list: jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            { id: "a", fee: 300, currency: "usd", type: "charge" },
            { id: "b", fee: 0, net: -100, currency: "usd", type: "stripe_fee" },
          ],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: "c", fee: -50, currency: "usd", type: "refund" }],
          has_more: false,
        }),
    },
  };
  expect((await fetchStripeExpense(client, range)).amountCents).toBe(350);
  expect(client.balanceTransactions.list.mock.calls[1][0].starting_after).toBe(
    "b",
  );
  expect(
    stripeTransactionFee({
      fee: 0,
      net: 100,
      currency: "usd",
      type: "fee_credit_funding",
    }),
  ).toBe(-100);
});
test("OpenAI costs follow pagination and avoid rounding each small line item", async () => {
  const costs = jest
    .fn()
    .mockResolvedValueOnce({
      data: [
        {
          start_time: 1,
          end_time: 2,
          results: [
            { amount: { currency: "usd", value: 0.004 } },
            { amount: { currency: "usd", value: 0.004 } },
          ],
        },
      ],
      has_more: true,
      next_page: "next",
    })
    .mockResolvedValueOnce({
      data: [
        {
          start_time: 2,
          end_time: 3,
          results: [{ amount: { currency: "usd", value: 1.001 } }],
        },
      ],
      has_more: false,
    });
  const result = await fetchOpenAiExpense(
    { admin: { organization: { usage: { costs } } } },
    range,
    ["proj_callbackiq"],
  );
  expect(result.amountCents).toBe(101);
  expect(costs.mock.calls[1][0]).toMatchObject({
    page: "next",
    project_ids: ["proj_callbackiq"],
  });
});
test("unsupported currency or missing provider amounts cannot become a zero-dollar success", async () => {
  await expect(
    fetchTwilioExpense(
      {
        usage: {
          records: { list: async () => [{ price: null, priceUnit: "usd" }] },
        },
      },
      range,
    ),
  ).rejects.toThrow();
  await expect(
    fetchStripeExpense(
      {
        balanceTransactions: {
          list: async () => ({
            data: [{ fee: 10, currency: "eur" }],
            has_more: false,
          }),
        },
      },
      range,
    ),
  ).rejects.toThrow();
});
test("monthly boundaries use completed UTC days and stop before the next month", () => {
  expect(range.end.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  expect(monthRange("2026-08", new Date("2026-09-07")).end.toISOString()).toBe(
    "2026-09-01T00:00:00.000Z",
  );
});
