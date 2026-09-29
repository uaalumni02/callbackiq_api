import crypto from 'node:crypto';
const missingSearch = encodeURIComponent(`scale-no-match-${crypto.randomUUID()}`);
// Response correctness checks shared by the mixed workload. Manifest IDs refer
// only to dedicated staging fixtures; never write returned customer data to logs.
export const OWNER_READ_ROUTES = ['requests', 'appointments', 'opportunities-ready', 'opportunities-waiting', 'opportunities-needs-me', 'opportunities', 'customer-detail', 'lead-search', 'call-search', 'conversation-search', 'customer-history', 'lead-search-miss', 'call-search-miss', 'conversation-search-miss'];
export async function exerciseOwnerReads({ get, tenant, observe }) {
  const leadId = tenant.probeLeadId, search = encodeURIComponent(tenant.probeSearch);
  if (!/^[a-f0-9]{24}$/i.test(leadId || '') || !tenant.probeSearch) throw new Error('Each staging tenant needs probeLeadId and probeSearch');
  const probe = async (name, path, check, envelope = false) => {
    const start = performance.now();
    try { const result = await get(path, tenant.token); check(envelope ? result : result.data); observe(name, performance.now() - start, true); return envelope ? result : result.data; }
    catch (error) { observe(name, performance.now() - start, false); throw error; }
  };
  const assert = value => { if (!value) throw new Error('Owner read correctness check failed'); };
  const owned = record => String(record.business?._id || record.business) === tenant.businessId;
  await probe('requests', '/api/interventions?view=requests&resolved=false', result => {
    assert(Array.isArray(result.data) && result.data.length <= 50 && result.data.every(owned) && Number.isFinite(result.total));
  }, true);
  const appointmentPage = await probe('appointments', '/api/appointments?view=all&pageSize=25', result => {
    assert(Array.isArray(result.data) && result.data.length <= 25 && result.data.every(owned) && result.pagination && Number.isFinite(result.summary?.pendingApprovals));
  }, true);
  if (appointmentPage.pagination.nextCursor) await probe('appointments', `/api/appointments?view=all&pageSize=25&cursor=${encodeURIComponent(appointmentPage.pagination.nextCursor)}`, result => {
    assert(Array.isArray(result.data) && result.data.length <= 25 && result.data.every(owned) && !result.data.some(item => appointmentPage.data.some(first => first._id === item._id)));
  }, true);
  const page = await probe('opportunities', '/api/owner/opportunities?view=all&limit=20', data => {
    assert(Array.isArray(data?.items) && data.items.length <= 20 && data.pagination && Number(data.pagination.total) >= Math.max(1000, Number(tenant.minimumLeadCount || 1000)));
  });
  if (page.pagination.nextCursor) await probe('opportunities', `/api/owner/opportunities?view=all&limit=20&includeSummary=false&cursor=${encodeURIComponent(page.pagination.nextCursor)}`, data => {
    assert(Array.isArray(data?.items) && data.items.length <= 20 && !data.items.some(item => page.items.some(first => first.id === item.id)));
  });
  for (const view of ['ready', 'waiting', 'needs_me']) {
    await probe(`opportunities-${view.replace('_', '-')}`, `/api/owner/opportunities?view=${view}&limit=20`, data => {
      assert(Array.isArray(data?.items) && data.items.length <= 20 && Number.isFinite(data.pagination?.total));
    });
  }
  const detail = await probe('customer-detail', `/api/customers/${leadId}/recovery-detail?limit=20`, data => {
    assert(String(data?.customer?._id) === leadId && owned(data.customer));
    for (const section of ['messages', 'calls', 'appointments', 'voiceSessions', 'interventions', 'conversations']) assert(Array.isArray(data[section]) && data[section].length <= 20 && data[section].every(owned));
    assert(data.pagination.messages.hasMore); // Deep history fixture is mandatory.
  });
  await probe('customer-history', `/api/customers/${leadId}/recovery-detail?section=messages&limit=20&cursor=${encodeURIComponent(detail.pagination.messages.nextCursor)}`, data => {
    assert(data?.items?.length > 0 && data.items.length <= 20 && data.items.every(owned) && !data.items.some(item => detail.messages.some(first => first._id === item._id)));
  });
  await probe('lead-search', `/api/leads?limit=20&search=${search}`, data => { assert(Array.isArray(data) && data.length <= 20 && data.every(owned) && data.some(x => String(x._id) === leadId)); });
  await probe('call-search', `/api/calls?limit=20&search=${search}`, data => { assert(Array.isArray(data) && data.length > 0 && data.length <= 20 && data.every(owned)); });
  await probe('conversation-search', `/api/conversations?limit=20&search=${search}`, data => { assert(Array.isArray(data) && data.length > 0 && data.length <= 20 && data.every(owned)); });
  for (const [name, route] of [['lead-search-miss', 'leads'], ['call-search-miss', 'calls'], ['conversation-search-miss', 'conversations']]) {
    await probe(name, `/api/${route}?limit=20&search=${missingSearch}`, data => { assert(Array.isArray(data) && data.length === 0); });
  }

}
export function validateOwnerReadReport(report, { minimum = 1001, p95Ms = 1500, p99Ms = 3000 } = {}) {
  const errors = [];
  for (const route of OWNER_READ_ROUTES) {
    const row = report?.[route];
    if (!row || !(row.count >= minimum) || row.failures !== 0 || !Number.isFinite(row.p95Ms) || !Number.isFinite(row.p99Ms) || row.p95Ms > p95Ms || row.p99Ms > p99Ms) errors.push(`owner_read:${route}`);
  }
  return errors;
}
