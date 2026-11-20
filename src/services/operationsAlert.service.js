// The caller uses the in-app alert's durable dedupe result before dispatching.
// Only operational identifiers and a bounded code leave this process.
export const notifyDeadJob = ({ jobType, id, businessId, errorCode }) => {
  const url = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!url) return;
  const payload = { jobType, id: String(id), businessId: String(businessId),
    errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(String(errorCode || '')) ? errorCode : 'PROCESSING_FAILED' };
  void Promise.resolve().then(() => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  })).catch(() => { /* Best effort; the in-app alert remains authoritative. */ });
};

export const persistAlertAndNotifyOperations = async (insert, payload) => {
  const alert = await insert(payload);
  const deadJob = /^(sms_processing_dead|webhook-work|integration_dead):(.+)$/.exec(payload.dedupeKey || '');
  if (deadJob) notifyDeadJob({
    jobType: deadJob[1] === 'sms_processing_dead' ? 'sms' : deadJob[1] === 'webhook-work' ? 'webhook-work' : 'integration',
    id: deadJob[2], businessId: payload.business, errorCode: payload.metadata?.errorCode,
  });
  return alert;
};
