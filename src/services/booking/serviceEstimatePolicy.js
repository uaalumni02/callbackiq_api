export const validPriceAmount = amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
const currency = amount => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
export const formatApprovedServiceEstimate = service => {
  if (service?.disclosePriceEstimate !== true || !validPriceAmount(service.priceEstimateMin) ||
      !validPriceAmount(service.priceEstimateMax) || service.priceEstimateMin > service.priceEstimateMax) return '';
  const range = service.priceEstimateMin === service.priceEstimateMax ? `about ${currency(service.priceEstimateMin)}` : `${currency(service.priceEstimateMin)}-${currency(service.priceEstimateMax)}`;
  const fee = service.discloseDiagnosticFee === true && validPriceAmount(service.diagnosticFee) ? ` A ${currency(service.diagnosticFee)} service-call fee may also apply.` : '';
  return `The rough estimate is ${range}.${fee} Final pricing depends on the actual scope and technician evaluation.`;
};
export const formatApprovedDiagnosticFee = service => service?.discloseDiagnosticFee === true && validPriceAmount(service.diagnosticFee)
  ? `The approved service-call fee is ${currency(service.diagnosticFee)}. This is not the total repair price; any additional work needs a separate estimate.` : '';
