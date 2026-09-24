import { scoreService, preferSpecificServices } from '../../../services/serviceEligibility/policy.js';
import ServiceOffering from "../../../models/serviceOffering.js";
import { normalizeServiceText, matchesServicePhrase } from '../../../services/catalog/servicePhrase.service.js';

const normalize = normalizeServiceText;

export const searchServicesTool = async ({ businessId, query }) => {
  const text = normalize(query);
  const services = await ServiceOffering.find({
    business: businessId,
    active: true,
    aiCanBook: true,
  }).lean();

  const scored = services
    .map((service) => {
      const excluded = (service.excludedKeywords || []).some((term) =>
        Boolean(normalize(term)) && matchesServicePhrase(text, term),
      );
      const score = excluded
        ? -1
        : scoreService(text, service);
      return { service, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.service.name.localeCompare(b.service.name));

  const positive = scored.filter((item) => item.score > 0);
  // A sole catalog service is not evidence that it matches the customer's job.
  const preferred = new Set(preferSpecificServices(positive.map(item => item.service)));
  const matches = positive.filter(item => preferred.has(item.service));

  // Only a positively matched, explicitly authorized diagnostic can resolve ambiguity.
  const diagnostics = matches.filter(({ service }) => service.diagnosticFallback === true);
  const chosen = matches.length > 1 && diagnostics.length === 1 ? diagnostics : matches;
  return chosen.slice(0, 5).map(({ service, score }) => ({
    id: String(service._id),
    name: service.name,
    category: service.category,
    durationMinutes: service.durationMinutes,
    priceEstimateMin: service.priceEstimateMin,
    priceEstimateMax: service.priceEstimateMax,
    disclosePriceEstimate: service.disclosePriceEstimate,
    priceEstimateDisclaimer: service.priceEstimateDisclaimer,
    diagnosticFee: service.diagnosticFee,
    discloseDiagnosticFee: service.discloseDiagnosticFee,
    requiresHumanReview: service.requiresHumanReview,
    score,
  }));
};

export default searchServicesTool;
