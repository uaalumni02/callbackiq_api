import { extractService } from '../messaging/smsIntentClassifier.service.js';
import { evaluateServiceEligibility } from '../serviceEligibility/serviceEligibility.service.js';
import ServiceOffering from '../../models/serviceOffering.js';

import { normalizeServiceText as normalize, matchesServicePhrase as containsPhrase } from '../catalog/servicePhrase.service.js';
const validAmount = amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
const currency = amount => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
}).format(amount);

// Public pricing is separate from internal job-value estimation and bookability.
// A single unrelated catalog entry is never evidence for quoting that service.
export const getApprovedServiceEstimate = async ({ businessId, serviceNeeded, customerMessage = '' } = {}) => {
  if (!businessId) return '';
  const text = normalize([serviceNeeded, customerMessage].filter(value => typeof value === 'string').join(' '));
  if (!text) return '';
  const eligibility = await evaluateServiceEligibility({ businessId, request: extractService(customerMessage) || text });
  if (eligibility.decision !== 'supported' || !eligibility.canEstimate && !/\b(?:fee|charge)\b/i.test(customerMessage)) return '';
  const services = await ServiceOffering.find({ business: businessId, active: true, aiCanDiscuss: true })
    .select('business name active aiCanDiscuss keywords excludedKeywords disclosePriceEstimate priceEstimateMin priceEstimateMax discloseDiagnosticFee diagnosticFee')
    .lean();
  const matches = services.filter(service => {
    if (String(service._id) !== eligibility.serviceId) return false;
    if (service.active !== true || service.aiCanDiscuss !== true || String(service.business) !== String(businessId)) return false;
    if ((service.excludedKeywords || []).some(term => containsPhrase(text, term))) return false;
    return [service.name, ...(service.keywords || [])].some(term => containsPhrase(text, term));
  });
  if (matches.length !== 1) return '';
  const service = matches[0];
  const feeRequested = /\b(?:diagnostic|service[- ]?call|call[- ]?out|trip)\s*(?:fee|charge|cost)?\b/i.test(customerMessage);
  if (feeRequested) {
    return service.discloseDiagnosticFee === true && validAmount(service.diagnosticFee)
      ? `The approved service-call fee is ${currency(service.diagnosticFee)}. This is not the total repair price; any additional work needs a separate estimate.`
      : '';
  }
  if (service.disclosePriceEstimate !== true || !validAmount(service.priceEstimateMin) ||
      !validAmount(service.priceEstimateMax) || service.priceEstimateMin > service.priceEstimateMax) return '';
  const range = service.priceEstimateMin === service.priceEstimateMax
    ? `about ${currency(service.priceEstimateMin)}`
    : `${currency(service.priceEstimateMin)}-${currency(service.priceEstimateMax)}`;
  const fee = service.discloseDiagnosticFee === true && validAmount(service.diagnosticFee)
    ? ` A ${currency(service.diagnosticFee)} service-call fee may also apply.` : '';
  // Always retain this limitation, even if a configured custom disclaimer is empty.
  return `The rough estimate is ${range}.${fee} Final pricing depends on the actual scope and technician evaluation.`;
};

export default getApprovedServiceEstimate;
