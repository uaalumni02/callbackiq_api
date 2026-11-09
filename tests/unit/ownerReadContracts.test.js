import { assertOwnerReadContract } from '../contracts/ownerReadContract.js';

const appointment = { _id: 'a1', status: 'held', startAt: '2027-01-15T17:00:00Z', endAt: '2027-01-15T18:00:00Z' };
const headers = { 'x-page-limit': '25', 'x-has-more': 'false' };

test.each([
  ['/api/appointments', { success: true, data: [appointment] }],
  ['/api/appointments/{id}', { success: true, data: appointment }],
  ['/api/conversations', { success: true, message: 'Conversations fetched', data: [] }],
  ['/api/leads', { success: true, message: 'Leads fetched', data: [] }],
  ['/api/billing/subscription', { success: true, message: 'Subscription fetched', data: {
    status: 'none', canStartTrial: true,
    billingDetails: { paymentMethod: { display: '' }, nextCharge: { display: '' }, invoices: [] },
  } }],
])('accepts existing wire shape for %s', (path, body) => {
  expect(() => assertOwnerReadContract(path, { body, headers })).not.toThrow();
});

test('rejects an undocumented appointment state', () => {
  expect(() => assertOwnerReadContract('/api/appointments/{id}', {
    body: { success: true, data: { ...appointment, status: 'provider_acknowledged' } },
  })).toThrow('response violates its contract');
});

test('requires the existing continuation header when another page is advertised', () => {
  expect(() => assertOwnerReadContract('/api/leads', {
    body: { success: true, message: 'Leads fetched', data: [] },
    headers: { ...headers, 'x-has-more': 'true' },
  })).toThrow('missing X-Next-Cursor');
});

test('does not accept malformed paginated results as the legacy appointment list', () => {
  expect(() => assertOwnerReadContract('/api/appointments', {
    body: { success: true, data: [appointment], pagination: { hasMore: false } },
  })).toThrow('response violates its contract');
});
