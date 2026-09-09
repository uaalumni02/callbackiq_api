import { normalizeServiceText as text, matchesServicePhrase as has } from '../catalog/servicePhrase.service.js';
// Internal opportunity values are never customer quotes.
export const moneyAmount = (value) =>
  value === null || value === undefined || value === "" || typeof value === "boolean"
    ? null
    : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const id = (value) => String(value?._id || value || "");
export const unknownEstimate = (basis = "Insufficient service-specific evidence") => ({ estimatedValue: null, valuation: {
  source: "unknown", minimum: null, maximum: null, serviceOffering: null,
  basis, updatedAt: new Date(),
} });
export const ownerEstimate = (amount, actorId = null) => ({
  estimatedValue: moneyAmount(amount), valuation: {
    source: "owner", minimum: moneyAmount(amount), maximum: moneyAmount(amount),
    serviceOffering: null, basis: "Explicit owner estimate", actorId,
    updatedAt: new Date(),
  },
});
export const isVerifiedEstimate = (record) =>
  ["owner", "service_catalog", "historical"].includes(record?.valuation?.source) && moneyAmount(record?.estimatedValue) !== null;
export const verifiedAmount = (record) => isVerifiedEstimate(record) ? moneyAmount(record.estimatedValue) : null;
export const verifiedAmountExpression = { $cond: [
  { $and: [{ $in: ["$valuation.source", ["owner", "service_catalog", "historical"]] }, { $isNumber: "$estimatedValue" }] }, "$estimatedValue", null,
] };
export const estimateCoverageGroup = {
  estimatedCount: { $sum: { $cond: [{ $ne: [verifiedAmountExpression, null] }, 1, 0] } },
  unestimatedCount: { $sum: { $cond: [{ $eq: [verifiedAmountExpression, null] }, 1, 0] } },
};
export function resolveOpportunityValue({ businessId, current, services = [], evidence = "", proposedService = "", selectedServiceId = null }) {
  if (current?.valuation?.source === "owner") return { estimatedValue: moneyAmount(current.estimatedValue), valuation: current.valuation };
  // An old amount cannot be identified as an owner edit merely from its number.
  if (current && (!current.valuation?.source || current.valuation.source === "legacy_unverified") && moneyAmount(current.estimatedValue) !== null) {
    return { estimatedValue: moneyAmount(current.estimatedValue), valuation: {
      source: "legacy_unverified", minimum: null, maximum: null, serviceOffering: null,
      basis: "Legacy amount; owner review required", updatedAt: new Date(),
    } };
  }
  const customerText = text(evidence);
  const candidates = services.filter(service => {
    if (id(service.business) !== id(businessId) || service.active !== true) return false;
    if (selectedServiceId) return id(service._id) === id(selectedServiceId);
    if (!customerText || (service.excludedKeywords || []).some(word => has(customerText, word))) return false;
    const name = text(service.name);
    // A leaking appliance is not evidence of replacement, installation, or repair scope.
    for (const [kind, pattern] of [[/replac|install/, /\b(replace|replacement|install|installation)\b/], [/repair/, /\b(repair|fix)\b/], [/maintenan|tune up/, /\b(maintenance|tune up)\b/]]) {
      if (kind.test(name) && !pattern.test(customerText)) return false;
    }
    if (/\b(no|not|dont|don t|without)\b.{0,25}\b(replace|replacement|install|repair)\b/.test(customerText)) return false;
    const matches = has(customerText, name) || (service.keywords || []).some(word => text(word).length >= 4 && has(customerText, word));
    if (!matches) return false;
    return !proposedService || text(proposedService) === name || has(text(proposedService), name) || has(name, proposedService) ||
      (service.keywords || []).some(word => text(word).length >= 4 && has(text(proposedService), word));
  });
  if (candidates.length !== 1) return unknownEstimate(candidates.length > 1
    ? "Multiple catalog services match; review the service before estimating."
    : services.length ? "No service-specific catalog match. Review the service scope and matching keywords."
      : "No active service catalog prices are configured for this business.");
  const service = candidates[0];
  const amount = moneyAmount(service.estimatedValue);
  const low = moneyAmount(service.priceEstimateMin), high = moneyAmount(service.priceEstimateMax);
  const hasRange = low !== null && high !== null && low <= high;
  if (amount === null && !hasRange) return unknownEstimate("The matching catalog service has no valid internal value or price range.");
  return { estimatedValue: amount ?? Math.round((low + high) / 2 * 100) / 100,
    valuation: { source: "service_catalog", minimum: hasRange ? low : amount,
      maximum: hasRange ? high : amount, serviceOffering: service._id,
      basis: `Business-approved service: ${service.name}${amount === null ? " (range midpoint)" : ""}`,
      evidence: String(evidence).slice(-1000), catalogUpdatedAt: service.updatedAt || null, updatedAt: new Date(),
    },
  };
}
