import {
  getDefaultNextCharge,
  getDefaultPaymentMethod,
  getNextChargeDetails,
  getPaymentMethodSummary,
  mapStripeInvoice,
} from '../../src/helpers/billing/stripeBillingDetails.js';

test.each([
  [{ card: { brand: 'visa', last4: '4242', exp_month: 10, exp_year: 2030 } }, 'Visa •••• 4242'],
  [{ card: {} }, 'Card •••• ----'],
  [{ type: 'link', link: { email: 'owner@example.invalid' } }, 'Link • owner@example.invalid'],
  [{ type: 'link', billing_details: { email: 'owner@example.invalid' } }, 'Link • owner@example.invalid'],
  [{ type: 'link' }, 'Link'],
  [{ type: 'cashapp' }, 'Cash App Pay'],
  [{ type: 'amazon_pay' }, 'Amazon Pay'],
  [{ type: 'klarna' }, 'Klarna'],
  [{ type: 'us_bank_account', us_bank_account: { last4: '1234' } }, 'Bank Account •••• 1234'],
  [{ type: 'us_bank_account' }, 'Bank Account •••• ----'],
  [{ type: 'sepa_debit', sepa_debit: { last4: '1234' } }, 'SEPA Debit •••• 1234'],
  [{ type: 'sepa_debit' }, 'SEPA Debit •••• ----'],
  [{ type: 'paypal' }, 'PayPal'],
  [{ type: 'new_wallet_type' }, 'New Wallet Type'],
  [{}, 'Payment Method'],
])('projects a Stripe payment method %j', async (paymentMethod, display) => {
  const stripe = { paymentMethods: { list: jest.fn().mockResolvedValue({ data: [paymentMethod] }) } };
  await expect(getPaymentMethodSummary(stripe, 'cus_test')).resolves.toMatchObject({ display });
  expect(stripe.paymentMethods.list).toHaveBeenCalledWith({ customer: 'cus_test', limit: 1 });
});

test('prefers the subscription payment method and then the invoice payment method', async () => {
  const stripe = {
    subscriptions: { retrieve: jest.fn()
      .mockResolvedValueOnce({ default_payment_method: { type: 'cashapp' } })
      .mockResolvedValueOnce({ latest_invoice: { payment_intent: { payment_method: { type: 'link' } } } }) },
    paymentMethods: { list: jest.fn() },
  };
  await expect(getPaymentMethodSummary(stripe, 'cus_test', 'sub_test')).resolves.toMatchObject({ type: 'cashapp' });
  await expect(getPaymentMethodSummary(stripe, 'cus_test', 'sub_test')).resolves.toMatchObject({ type: 'link' });
  expect(stripe.paymentMethods.list).not.toHaveBeenCalled();
});

test('uses the existing empty payment method for missing or failed provider reads', async () => {
  const stripe = { paymentMethods: { list: jest.fn().mockResolvedValueOnce({ data: [] }).mockRejectedValueOnce(new Error('read failed')) } };
  await expect(getPaymentMethodSummary(null)).resolves.toEqual(getDefaultPaymentMethod());
  await expect(getPaymentMethodSummary(stripe, 'cus_test')).resolves.toEqual(getDefaultPaymentMethod());
  await expect(getPaymentMethodSummary(stripe, 'cus_test')).resolves.toEqual(getDefaultPaymentMethod());
});

test('formats the upcoming invoice and falls back to subscription price if it is unavailable', async () => {
  const stripe = {
    invoices: { retrieveUpcoming: jest.fn()
      .mockResolvedValueOnce({ amount_due: 9900, currency: 'usd', period_end: 1234 })
      .mockRejectedValueOnce(new Error('upcoming invoice unavailable')) },
    subscriptions: { retrieve: jest.fn().mockResolvedValue({
      items: { data: [{ price: { unit_amount: 12000, currency: 'usd' } }] },
      current_period_end: 2345,
    }) },
  };
  await expect(getNextChargeDetails(stripe, 'cus_test', 'sub_test')).resolves.toEqual({
    amount: 9900, currency: 'usd', display: '$99.00', nextPaymentAttempt: new Date(1234000),
  });
  await expect(getNextChargeDetails(stripe, 'cus_test', 'sub_test')).resolves.toEqual({
    amount: 12000, currency: 'usd', display: '$120.00', nextPaymentAttempt: new Date(2345000),
  });
});

test('returns default charge when the provider cannot supply billing details', async () => {
  const stripe = { subscriptions: { retrieve: jest.fn().mockRejectedValue(new Error('read failed')) } };
  await expect(getNextChargeDetails(null)).resolves.toEqual(getDefaultNextCharge());
  await expect(getNextChargeDetails({}, 'cus_test')).resolves.toEqual(getDefaultNextCharge());
  await expect(getNextChargeDetails(stripe, null, 'sub_test')).resolves.toEqual(getDefaultNextCharge());
});

test('preserves invoice amount, timestamp and absent-field defaults', () => {
  expect(mapStripeInvoice({ id: 'in_test' })).toMatchObject({
    number: 'in_test', status: 'unknown', amountPaid: 0, amountPaidDisplay: '$0.00', createdAt: null,
  });
  expect(mapStripeInvoice({
    id: 'in_test', number: '2027-01', status: 'paid', currency: 'usd',
    amount_due: 9900, amount_paid: 9900, hosted_invoice_url: 'https://example.invalid/invoice',
    invoice_pdf: 'https://example.invalid/invoice.pdf', created: 1234, period_start: 5678, period_end: 9876,
  })).toMatchObject({
    number: '2027-01', amountDueDisplay: '$99.00', amountPaidDisplay: '$99.00',
    createdAt: new Date(1234000), periodStart: new Date(5678000), periodEnd: new Date(9876000),
  });
});
