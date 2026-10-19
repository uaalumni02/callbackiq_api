/* Pure, deterministic MeekCall infrastructure cost rules. No credentials or DB dependencies. */
export const START_PERIOD = '2026-10';
export const RENDER_PLANS = Object.freeze([
  { id: 'render-api', label: 'Render · API', monthlyCents: 2500, envId: 'RENDER_API_SERVICE_ID', envName: 'RENDER_API_SERVICE_NAME', resource: 'service' },
  { id: 'render-worker', label: 'Render · Worker', monthlyCents: 700, envId: 'RENDER_WORKER_SERVICE_ID', envName: 'RENDER_WORKER_SERVICE_NAME', resource: 'service' },
  { id: 'render-redis', label: 'Render · Redis / Key Value', monthlyCents: 1000, envId: 'RENDER_REDIS_ID', envName: 'RENDER_REDIS_NAME', resource: 'keyValue' },
]);
export const VERCEL_PLAN_CENTS = 2000;
export const DOMAIN_ANNUAL_CENTS = 1125;
export const DOMAIN_NAME = 'meekcall.com';

export function domainAllocationCents(period) {
  // 9 × 94c + 3 × 93c = exactly $11.25 per calendar year.
  const month = Number(period.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) throw Error('Invalid period');
  return month % 4 === 0 ? 93 : 94;
}

export function parseVercelCharges(jsonl, domain = DOMAIN_NAME) {
  if (typeof jsonl !== 'string' || Buffer.byteLength(jsonl, 'utf8') > 4_000_000) throw Error('Vercel response exceeds safe size');
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 10_000) throw Error('Vercel charge count exceeds safe limit');
  let total = 0, domainTotal = 0, suspiciousDomainRows = 0;
  const target = domain.toLowerCase();
  for (const line of lines) {
    const charge = JSON.parse(line);
    if (!charge || typeof charge !== 'object' || Array.isArray(charge)) throw Error('Invalid Vercel billing row');
    if (String(charge.BillingCurrency).toUpperCase() !== 'USD') throw Error('Vercel billing currency must be USD');
    if (charge.BilledCost == null || charge.BilledCost === '' || !Number.isFinite(Number(charge.BilledCost))) throw Error('Invalid Vercel charge amount');
    const dollars = Number(charge.BilledCost);
    if (Math.abs(dollars) > 1_000_000) throw Error('Unexpected Vercel charge');
    const fields = [charge.ServiceName, charge.SkuId, charge.ChargeDescription,
      charge.ResourceName, JSON.stringify(charge.Tags ?? {})].filter(Boolean).join(' ').toLowerCase();
    const isDomain = fields.includes(target);
    if (isDomain) domainTotal += dollars;
    else if (/\bdomain(s| registration| renewal)?\b/.test(String(charge.ServiceName || '').toLowerCase())) suspiciousDomainRows++;
    total += dollars;
  }
  return {
    amountCents: Math.round(total * 100),
    matchedDomainCents: Math.round(domainTotal * 100),
    rows: lines.length,
    unidentifiedDomainRows: suspiciousDomainRows,
  };
}

export function matchRenderInventory(services, keyValues, config = {}) {
  return RENDER_PLANS.map((plan) => {
    const wantedId = String(config[plan.envId] || '').trim();
    const wantedName = String(config[plan.envName] || '').trim();
    const entries = plan.resource === 'keyValue' ? keyValues : services;
    const found = entries.find((item) => {
      const value = item?.[plan.resource] || item;
      return wantedId ? value?.id === wantedId : wantedName ? value?.name === wantedName : false;
    });
    const resource = found?.[plan.resource] || found;
    return {
      id: plan.id,
      configured: Boolean(wantedId || wantedName),
      verified: Boolean(resource),
      name: resource?.name || null,
      plan: resource?.plan || resource?.serviceDetails?.plan || resource?.serviceDetails?.instanceType || null,
      status: resource?.suspended === 'suspended' ? 'suspended' : resource?.status || (resource ? 'found' : null),
      // Inventory is not an invoice: no amount is taken from an instance plan name.
    };
  });
}

export function makeInfrastructureSummary(period, vercelRecord = null, inventoryRecord = null, now = new Date()) {
  const active = period >= START_PERIOD;
  if (!active) return { rows: [], knownCents: 0, forecastCents: 0, complete: true, legacyHostingExcluded: false };
  const vercel = vercelRecord?.data || null;
  const baseRenewalYear = Math.max(2027, now.getUTCFullYear());
  let renewalYear = baseRenewalYear;
  if (new Date(Date.UTC(renewalYear, 9, 18)) <= now) renewalYear += 1;
  const nextDomainRenewal = `${renewalYear}-10-18`;
  const inventory = inventoryRecord?.data || null;
  const reported = Boolean(vercel?.syncedAt && vercel?.rows > 0 && Number.isInteger(vercel.amountCents) && Number.isInteger(vercel.matchedDomainCents));
  const stale = reported && (now - new Date(vercel.syncedAt) > 12 * 60 * 60 * 1000 || Boolean(vercel.errorCode));
  const domainIncluded = reported && vercel.matchedDomainCents !== 0;
  const vercelAmount = reported ? vercel.amountCents - vercel.matchedDomainCents : VERCEL_PLAN_CENTS;
  const rows = [
    {
      id: 'vercel-ui', label: 'Vercel · UI', amountCents: vercelAmount,
      forecastCents: reported ? Math.max(VERCEL_PLAN_CENTS, vercelAmount) : VERCEL_PLAN_CENTS,
      basis: reported ? 'provider_reported' : 'estimated',
      sourceLabel: reported ? 'Vercel billing API · actual charges' : 'Configured plan estimate',
      stale: Boolean(stale), status: reported ? (stale ? 'stale' : 'synced') : (vercel?.errorCode ? 'error' : 'estimated'),
      details: reported ? (domainIncluded ? `Domain renewal charge of $${(vercel.matchedDomainCents / 100).toFixed(2)} removed to avoid counting it twice` : 'Entire configured Vercel team; domain reconciliation checked') : 'Vercel API not configured or has not returned charge rows',
      syncedAt: vercel?.syncedAt || null,
      errorCode: vercel?.errorCode || null,
    },
    ...RENDER_PLANS.map((plan) => {
      const match = inventory?.resources?.find((r) => r.id === plan.id);
      return {
        id: plan.id, label: plan.label, amountCents: plan.monthlyCents, forecastCents: plan.monthlyCents,
        basis: 'estimated', sourceLabel: 'Fixed monthly plan estimate',
        status: !inventory ? 'estimated' : match?.verified ? 'inventory_verified' : 'unverified',
        details: match?.verified ? `${match.name}${match.plan ? ` · ${match.plan}` : ''}${match.status === 'suspended' ? ' · suspended; verify bill' : ''}` : 'Render inventory not connected or resource not matched; verify amount against invoice',
        syncedAt: inventory?.syncedAt || null,
        errorCode: inventory?.errorCode || null,
      };
    }),
    {
      id: 'meekcall-domain', label: 'meekcall.com · Domain', amountCents: domainAllocationCents(period), forecastCents: domainAllocationCents(period),
      basis: 'estimated', sourceLabel: '$11.25 annual renewal · monthly allocation',
      status: domainIncluded ? 'reconciled' : 'estimated',
      details: domainIncluded ? `Domain billing recognized in Vercel charges and excluded from the Vercel line. Next renewal: ${nextDomainRenewal}` : `Annual renewal is allocated monthly. Next renewal: ${nextDomainRenewal}. Verify against Vercel billing.`,
      nextRenewalDate: nextDomainRenewal,
    },
    { id: 'ngrok', label: 'ngrok', amountCents: 0, forecastCents: 0, basis: 'inactive', sourceLabel: 'Retired · $0 ongoing', status: 'inactive', details: 'Historical records remain in the original expense ledger.' },
  ];
  return { rows, knownCents: rows.reduce((t, r) => t + r.amountCents, 0), forecastCents: rows.reduce((t, r) => t + r.forecastCents, 0), complete: !stale && reported, domainReconciled: domainIncluded, legacyHostingExcluded: true };
}
