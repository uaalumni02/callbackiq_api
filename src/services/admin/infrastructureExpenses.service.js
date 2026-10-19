/* Isolated, read-only infrastructure reporting. Never sends provider write requests. */
import { AdminReportingState } from '../../models/adminReporting.js';
import {
  matchRenderInventory,
  makeInfrastructureSummary,
  parseVercelCharges,
} from './infrastructureCosts.logic.js';

const idForVercel = (period) => `meekcall:infra:vercel:${period}`;
const inventoryId = 'meekcall:infra:render:inventory';
const utcMonth = (date) => date.toISOString().slice(0, 7);
const previousMonth = (date) => utcMonth(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
const todayUtc = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

async function readOnlyGet(url, token, { expectJson = false, fetcher = fetch } = {}) {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: expectJson ? 'application/json' : 'application/x-ndjson' },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) {
    const e = new Error('Provider cost access unavailable');
    e.code = [401, 403].includes(response.status) ? 'ACCESS_DENIED' : 'PROVIDER_REQUEST_FAILED';
    throw e;
  }
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > 4_000_000) throw new Error('Provider response too large');
  // fetch's text()/json() handle transfers without storing credentials or raw errors.
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > 4_000_000) throw new Error('Provider response too large');
  return expectJson ? JSON.parse(raw) : raw;
}

async function fetchVercelPeriod(period, now, fetcher) {
  const from = new Date(`${period}-01T00:00:00Z`);
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  // Like the existing Twilio/OpenAI reconciliation: use completed UTC days.
  const to = new Date(Math.min(+next, +todayUtc(now)));
  if (to <= from) return { amountCents: 0, matchedDomainCents: 0, rows: 0, unidentifiedDomainRows: 0 };
  const url = new URL('https://api.vercel.com/v1/billing/charges');
  url.searchParams.set('teamId', process.env.VERCEL_BILLING_TEAM_ID);
  url.searchParams.set('from', from.toISOString());
  url.searchParams.set('to', to.toISOString());
  return {
    ...parseVercelCharges(await readOnlyGet(url, process.env.VERCEL_BILLING_TOKEN, { fetcher })),
    throughDate: to.toISOString(),
  };
}

async function getRenderPages(path, fetcher) {
  let cursor = null;
  const items = [];
  for (let i = 0; i < 10; i++) {
    const url = new URL(`https://api.render.com/v1/${path}`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await readOnlyGet(url, process.env.RENDER_REPORTING_API_KEY, { expectJson: true, fetcher });
    if (!Array.isArray(page)) throw new Error('Unexpected Render inventory response');
    items.push(...page);
    if (page.length < 100) return items;
    const nextCursor = page.at(-1)?.cursor;
    if (!nextCursor || nextCursor === cursor) throw new Error('Render pagination incomplete');
    cursor = nextCursor;
  }
  throw new Error('Render inventory pagination limit');
}

async function saveSnapshot(key, data) {
  await AdminReportingState.updateOne({ _id: key }, { $set: { data } }, { upsert: true });
}

async function saveFailedSnapshot(key, code, now) {
  // Preserve last successful data on failed sync, without exposing token or error text.
  await AdminReportingState.updateOne({ _id: key }, {
    $set: { 'data.errorCode': code, 'data.lastAttemptAt': now },
  }, { upsert: true });
}

export async function syncInfrastructureExpenses({ now = new Date(), fetcher = fetch, progress = () => {} } = {}) {
  const results = [];
  if (process.env.VERCEL_BILLING_TOKEN && process.env.VERCEL_BILLING_TEAM_ID) {
    for (const period of [utcMonth(now), previousMonth(now)]) {
      try {
        const data = await fetchVercelPeriod(period, now, fetcher);
        await saveSnapshot(idForVercel(period), { ...data, syncedAt: now, lastAttemptAt: now, errorCode: null });
        results.push({ provider: 'vercel', period, status: 'synced' });
      } catch (e) {
        await saveFailedSnapshot(idForVercel(period), e.code || 'SYNC_FAILED', now);
        results.push({ provider: 'vercel', period, status: 'failed' });
      }
    }
  } else {
    results.push({ provider: 'vercel', status: 'not_configured' });
  }
  if (process.env.RENDER_REPORTING_API_KEY) {
    try {
      const [services, keyValues] = await Promise.all([
        getRenderPages('services', fetcher),
        getRenderPages('key-value', fetcher),
      ]);
      const resources = matchRenderInventory(services, keyValues, process.env);
      await saveSnapshot(inventoryId, { resources, syncedAt: now, lastAttemptAt: now, errorCode: null });
      results.push({ provider: 'render', status: 'synced' });
    } catch (e) {
      await saveFailedSnapshot(inventoryId, e.code || 'SYNC_FAILED', now);
      results.push({ provider: 'render', status: 'failed' });
    }
  } else {
    results.push({ provider: 'render', status: 'not_configured' });
  }
  progress(results.map((r) => `${r.provider}:${r.status}`).join(', '));
  return results;
}

export async function infrastructureExpenseSummary(now = new Date()) {
  const period = utcMonth(now);
  const previous = previousMonth(now);
  const docs = await AdminReportingState.find({
    _id: { $in: [idForVercel(period), idForVercel(previous), inventoryId] },
  }).lean().maxTimeMS(5000);
  const map = new Map(docs.map((d) => [d._id, d]));
  const current = makeInfrastructureSummary(period, map.get(idForVercel(period)), map.get(inventoryId), now);
  const lastMonth = makeInfrastructureSummary(previous, map.get(idForVercel(previous)), map.get(inventoryId), now);
  return {
    ...current,
    period,
    previousPeriod: previous,
    previousKnownCents: lastMonth.rows.length ? lastMonth.knownCents : null,
    note: 'Vercel uses billed USD charges; confirmed domain charges are removed before the domain is allocated monthly. Render is inventory-backed estimates, not a reported invoice. The historical hosting category is omitted from the combined total to prevent duplication.',
  };
}
