import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVercelCharges,
  matchRenderInventory,
  domainAllocationCents,
  makeInfrastructureSummary,
} from '../../src/services/admin/infrastructureCosts.logic.js';

const row = (dollars, overrides = {}) => JSON.stringify({
  BilledCost: String(dollars), BillingCurrency: 'USD', ServiceName: 'Pro Subscription',
  SkuId: 'sub-pro', Tags: {}, ...overrides,
});

test('Vercel total reconciles explicitly identified domain charges, never counts renewal twice', () => {
  const result = parseVercelCharges([
    row(20),
    row(11.25, { ServiceName: 'Domains', Tags: { Domain: 'meekcall.com' } }),
    row(-1.20, { ServiceName: 'Credit Adjustment' }),
  ].join('\n'));
  assert.equal(result.amountCents, 3005);
  assert.equal(result.matchedDomainCents, 1125);
  const s = makeInfrastructureSummary('2026-10', { data: { ...result, syncedAt: '2026-10-18T12:00:00Z' } }, null, new Date('2026-10-18T16:00:00Z'));
  assert.equal(s.rows.find(x => x.id === 'vercel-ui').amountCents, 1880);
  assert.equal(s.rows.find(x => x.id === 'meekcall-domain').amountCents, 94);
  assert.equal(s.knownCents, 6174); // $18.80 Vercel net + $42 Render + $0.94 domain
  assert.equal(s.domainReconciled, true);
  assert.equal(s.rows.find(x => x.id === 'meekcall-domain').nextRenewalDate, '2027-10-18');
});

test('unclassified domain-like rows are not guessed and no unsupported currency silently converts', () => {
  const input = row(11.25, { ServiceName: 'Domains', Tags: {} });
  const result = parseVercelCharges(input);
  assert.equal(result.unidentifiedDomainRows, 1);
  assert.equal(result.matchedDomainCents, 0);
  assert.throws(() => parseVercelCharges(row(2, { BillingCurrency: 'EUR' })), /USD/);
  assert.throws(() => parseVercelCharges(row('xyz')), /amount/);
});

test('fixed baseline is $62.94 for October, including domain annual allocation', () => {
  const s = makeInfrastructureSummary('2026-10', null, null);
  assert.equal(s.knownCents, 6294);
  assert.equal(s.rows.find(x => x.id === 'ngrok').amountCents, 0);
  assert.equal(s.rows.find(x => x.id === 'vercel-ui').basis, 'estimated');
  assert.equal(s.rows.filter(x => x.basis === 'estimated').length, 5);
  assert.equal(makeInfrastructureSummary('2026-09').rows.length, 0);
});

test('annual domain amortization adds to exactly 1125 cents', () => {
  assert.equal(Array.from({ length: 12 }, (_, i) => domainAllocationCents(`2027-${String(i + 1).padStart(2, '0')}`)).reduce((a, b) => a + b), 1125);
});

test('Render inventory matching is explicit, cannot silently match another tenant resource', () => {
  const matched = matchRenderInventory([
    { service: { id: 'srv-other', name: 'Other API', serviceDetails: { plan: 'pro' } } },
    { service: { id: 'srv-api', name: 'MeekCall API', serviceDetails: { plan: 'starter' } } },
  ], [{ keyValue: { id: 'red-one', name: 'MeekCall Redis', plan: 'starter' } }], {
    RENDER_API_SERVICE_ID: 'srv-api', RENDER_REDIS_ID: 'red-one', RENDER_WORKER_SERVICE_ID: 'srv-worker',
  });
  assert.equal(matched[0].name, 'MeekCall API');
  assert.equal(matched[0].verified, true);
  assert.equal(matched[1].verified, false);
  assert.equal(matched[2].verified, true);
  assert.equal(matched[0].plan, 'starter');
});

test('stale provider charges remain visible but never get an invented fresh status', () => {
  const s = makeInfrastructureSummary('2026-10', { data: { rows: 1, amountCents: 2000, matchedDomainCents: 0, syncedAt: '2026-10-01T00:00:00Z' } }, null, new Date('2026-10-18'));
  assert.equal(s.rows[0].status, 'stale');
  assert.equal(s.complete, false);
});
