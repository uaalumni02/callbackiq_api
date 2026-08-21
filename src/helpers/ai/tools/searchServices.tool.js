import ServiceOffering from "../../../models/serviceOffering.js";

const normalize = (value) => String(value || "").trim().toLowerCase();

export const searchServicesTool = async ({ businessId, query }) => {
  const text = normalize(query);
  const services = await ServiceOffering.find({
    business: businessId,
    active: true,
    aiCanBook: true,
  }).lean();

  const scored = services
    .map((service) => {
      const terms = [service.name, service.category, ...(service.keywords || [])]
        .map(normalize)
        .filter(Boolean);
      const excluded = (service.excludedKeywords || []).some((term) =>
        text.includes(normalize(term)),
      );
      const score = excluded
        ? -1
        : terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      return { service, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.service.name.localeCompare(b.service.name));

  const positive = scored.filter((item) => item.score > 0);
  const matches = positive.length > 0 ? positive : services.length === 1 ? [{ service: services[0], score: 0 }] : [];

  return matches.slice(0, 5).map(({ service, score }) => ({
    id: String(service._id),
    name: service.name,
    category: service.category,
    durationMinutes: service.durationMinutes,
    estimatedValue: service.estimatedValue,
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
