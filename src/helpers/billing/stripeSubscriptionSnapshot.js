export const stripePeriodDates = (remote, fallback = {}) => {
  const item = remote?.items?.data?.[0];
  const date = (value, previous) => value ? new Date(value * 1000) : previous || null;
  return {
    currentPeriodStart: date(remote?.current_period_start || item?.current_period_start, fallback.currentPeriodStart),
    currentPeriodEnd: date(remote?.current_period_end || item?.current_period_end, fallback.currentPeriodEnd),
  };
};

export function canonicalInvoiceProjection(remote, eventInvoice, eventStatus) {
  const latest = remote?.latest_invoice;
  const id = typeof latest === 'string' ? latest : latest?.id;
  const latestStatus = typeof latest === 'object' ? latest?.status : null;
  let paymentStatus = remote?.status || '';
  if (latestStatus === 'paid') paymentStatus = 'paid';
  else if (id === eventInvoice?.id || !id) paymentStatus = eventStatus;
  return {
    latestInvoiceId: id || eventInvoice?.id || '',
    lastPaymentStatus: paymentStatus,
  };
}
