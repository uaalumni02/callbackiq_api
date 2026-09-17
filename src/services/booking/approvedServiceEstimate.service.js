import { extractService } from '../messaging/smsIntentClassifier.service.js';
import { evaluateServiceEligibility } from '../serviceEligibility/serviceEligibility.service.js';
import ServiceOffering from '../../models/serviceOffering.js';

import { normalizeServiceText as normalize, matchesServicePhrase as containsPhrase } from '../catalog/servicePhrase.service.js';
import { formatApprovedServiceEstimate, formatApprovedDiagnosticFee } from './serviceEstimatePolicy.js';

// Public pricing is separate from internal job-value estimation and bookability.
// A single unrelated catalog entry is never evidence for quoting that service.
export const getApprovedServiceEstimate = async ({ businessId, serviceNeeded, customerMessage = '' } = {}) => {
  if (!businessId) return '';
  serviceNeeded = typeof serviceNeeded === 'string' ? serviceNeeded.trim() : '';
  customerMessage = typeof customerMessage === 'string' ? customerMessage : '';
  const extracted = extractService(customerMessage, { lead: { serviceNeeded } });
  if (!extracted && (!serviceNeeded || /^(unknown|not provided|n\/a)$/i.test(serviceNeeded.trim()))) return '';
  const text = normalize([serviceNeeded, customerMessage].filter(value => typeof value === 'string').join(' '));
  if (!text) return '';
  const eligibility = await evaluateServiceEligibility({ businessId, request: extracted || serviceNeeded || text });
  if (eligibility.decision !== 'supported' || !eligibility.canEstimate && !/\b(?:fee|charge)\b/i.test(customerMessage)) return '';
  const services = await ServiceOffering.find({ business: businessId, active: true, aiCanDiscuss: true })
    .select('business name active aiCanDiscuss keywords excludedKeywords disclosePriceEstimate priceEstimateMin priceEstimateMax discloseDiagnosticFee diagnosticFee')
    .lean();
  const matches = services.filter(service => {
    if (String(service._id) !== eligibility.serviceId) return false;
    if (service.active !== true || service.aiCanDiscuss !== true || String(service.business) !== String(businessId)) return false;
    if ((service.excludedKeywords || []).some(term => containsPhrase(text, term))) return false;
    return true; // The eligibility resolver already matched this exact offering and its scope.
  });
  if (matches.length !== 1) return '';
  const service = matches[0];
  const feeRequested = /\b(?:diagnostic|service[- ]?call|call[- ]?out|trip)\s*(?:fee|charge|cost)?\b/i.test(customerMessage);
  return feeRequested ? formatApprovedDiagnosticFee(service) : formatApprovedServiceEstimate(service);
};

export default getApprovedServiceEstimate;
