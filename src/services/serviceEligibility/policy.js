import { normalizeServiceText as normalize, matchesServicePhrase } from '../catalog/servicePhrase.service.js';

// These aliases describe customer evidence, never what a business is licensed or willing to do.
const domains = {
  plumbing: /\b(?:plumb(?:er|ing)?|pipe|pipes|faucet|toilet|bathtub|tub|shower|sink|drain|sewer|water heater|hot water heater|sump pump|septic)\b/,
  roofing: /\b(?:roof|roofer|roofing|shingle|shingles|flashing|skylight)\b/,
  hvac: /\b(?:hvac|ac|air conditioner|air conditioning|furnace|heat pump|thermostat|duct|ductwork|no heat|no cooling)\b/,
  electrical: /\b(?:electrician|electrical|outlet|breaker|circuit|wiring|panel|light switch)\b/,
  restoration: /\b(?:restoration|water damage|mold|remediation|drying|smoke damage)\b/,
  garage_door: /\b(?:garage door|garage opener)\b/,
  locksmith: /\b(?:locksmith|lockout|locked out|rekey|door lock|deadbolt)\b/,
  landscaping: /\b(?:landscap(?:e|ing)|lawn|mowing|tree|hedge|irrigation|sprinkler|sod)\b/,
};
const aliases = {
  roofer: 'roofing', roof: 'roofing', plumber: 'plumbing', electrician: 'electrical',
  'heating and cooling': 'hvac', 'garage door': 'garage_door', 'garage doors': 'garage_door',
};
const generic = new Set('a an the my our your is are was be it this that i we you need needs help with for to of and or on in at do does can could please service services repair repairs repaired repairing fix fixing install installation replace replacement maintenance inspection inspect problem issue broken damage damaged leak leaking general residential commercial other work request'.split(' '));
export const meaningfulServicePhrase = value => normalize(value).split(' ').some(word => word && !generic.has(word) && !/^(?:repairs?|repairing|repaired|fix(?:es|ed|ing)?|leaks?|leaking|install(?:s|ed|ing|ation)?|replac(?:e|es|ed|ing|ement)|clean(?:s|ed|ing)?|inspect(?:s|ed|ing|ion)?|maintain(?:s|ed|ing)?|care|help|assistance)$/.test(word));
export const serviceDomains = value => Object.entries(domains).filter(([, pattern]) => pattern.test(normalize(value))).map(([key]) => key);
const domainOf = service => aliases[normalize(service.category)] || normalize(service.category);
const activeText = value => String(value || '').replace(/^.*\b(?:instead|i meant|rather than that|forget that)\b[:, ]*/i, '').trim();
// Negated clauses cannot supply positive eligibility evidence.
const affirmedText = value => activeText(value).split(/\bbut\b|[;.!?]/i)
  .filter(part => !/\b(?:do not|don['’]?t|not|no longer|without)\s+(?:need|want|roof|plumb|repair|replace|install|service)/i.test(part)).join(' ');
export const scoreService = (query, service) => {
  const text = normalize(affirmedText(query));
  if (!text) return 0;
  if ((service.excludedKeywords || []).some(term => matchesServicePhrase(normalize(query), term))) return 0;
  const evidenceDomains = serviceDomains(text);
  const category = domainOf(service);
  // A known conflicting trade cannot win on a generic keyword such as "repair".
  if (evidenceDomains.length && domains[category] && !evidenceDomains.includes(category)) return 0;
  const broadName = normalize(service.name).replace(/\b(?:service|services|general|residential|commercial)\b/g, '').trim();
  const broadMatch = (aliases[broadName] || broadName) === category && evidenceDomains.includes(category);
  return Number(broadMatch) + [service.name, service.category, ...(service.keywords || [])]
    .filter(meaningfulServicePhrase)
    .reduce((score, term) => score + (matchesServicePhrase(text, term) ? 1 : 0), 0);
};

const result = (decision, reason, request, extra = {}) => ({ decision, reason, request: String(request || '').slice(0, 500), serviceId: null, ...extra });
export const evaluateServicePolicy = ({ request, services = [], policy = {}, semanticService = '', confidence = 0 } = {}) => {
  const raw = activeText(request), text = normalize(raw);
  if (!text) return result('needs_clarification', 'service_missing', raw);
  const active = services.filter(service => service.active === true);
  // Business-level exclusions apply to every offering. Offering exclusions apply only to that offering.
  if ((policy.excludedServices || []).some(term => matchesServicePhrase(text, term))) {
    return result('unsupported', 'explicit_business_exclusion', raw);
  }
  if (/\b(?:unsure|not sure|don t know|unknown source)\b/.test(text)) return result('needs_staff_review', 'customer_unsure', raw);
  if (/\b(?:ceiling|water from above)\b/.test(text) && /\b(?:water|leaks?|leaking|drips?|dripping|wet)\b/.test(text) &&
      !/\b(?:pipe|roof|shingle|faucet|toilet)\b/.test(text)) {
    return result('needs_clarification', 'water_source_uncertain', raw);
  }
  const rawDomains = serviceDomains(affirmedText(raw));
  const semanticDomains = serviceDomains(semanticService);
  const semanticSafe = confidence >= 80 && semanticService &&
    (!rawDomains.length || semanticDomains.every(domain => rawDomains.includes(domain)));
  // AI proposes a description only; the same catalog and exclusion checks still apply.
  if (semanticSafe && (policy.excludedServices || []).some(term => matchesServicePhrase(semanticService, term))) {
    return result('unsupported', 'explicit_business_exclusion', raw);
  }
  const excluded = active.filter(service => (service.excludedKeywords || []).some(term => matchesServicePhrase(text, term) ||
    (semanticSafe && matchesServicePhrase(semanticService, term))));
  const matches = active.filter(service => !excluded.includes(service) &&
    (scoreService(raw, service) > 0 || (semanticSafe && scoreService(semanticService, service) > 0)));
  if (rawDomains.length > 1) {
    const covered = new Set(matches.flatMap(service => [domainOf(service), ...serviceDomains(service.name)]));
    if (rawDomains.some(domain => !covered.has(domain))) return result('needs_clarification', 'mixed_service_request', raw);
  }
  if (matches.length > 1) return result('needs_clarification', 'multiple_services', raw, { choices: matches.slice(0, 4).map(s => s.name) });
  if (matches.length === 1) {
    const service = matches[0];
    return result(service.aiCanDiscuss !== true || service.requiresHumanReview === true ? 'needs_staff_review' : 'supported',
      service.aiCanDiscuss !== true ? 'discussion_requires_staff' : service.requiresHumanReview ? 'service_requires_staff' : 'catalog_match', raw,
      { serviceId: String(service._id), serviceName: service.name, canBook: service.aiCanBook === true,
        canEstimate: service.aiCanDiscuss === true && service.disclosePriceEstimate === true });
  }
  if (excluded.length && (policy.catalogComplete === true || excluded.length === active.length)) {
    return result('unsupported', 'offering_exclusion', raw);
  }
  if (policy.catalogComplete === true && (rawDomains.length || (semanticSafe && semanticDomains.length))) {
    return result('unsupported', 'complete_catalog_no_match', raw);
  }
  if (!meaningfulServicePhrase(text)) return result('needs_clarification', 'service_missing', raw);
  return result('needs_staff_review', policy.catalogComplete ? 'unrecognized_service' : 'catalog_incomplete', raw);
};

export const eligibilityReply = (eligibility, businessName = 'This business') => {
  if (eligibility.decision === 'unsupported') return `${businessName} does not offer that requested service. I can't arrange an appointment or provide a price for it.`;
  if (eligibility.reason === 'water_source_uncertain') return 'Do you know whether the water is coming from a pipe or from the roof, or are you unsure?';
  if (eligibility.reason === 'mixed_service_request') return 'Those may be separate services. Which issue would you like us to check first?';
  if (eligibility.reason === 'multiple_services') return `Which service do you need: ${(eligibility.choices || []).join(' or ')}?`;
  if (eligibility.decision === 'needs_clarification') return 'What equipment or part of the property needs service?';
  return "I can't verify that this business can accept that work. Would you like to submit the request for staff review? Acceptance and a callback time aren't guaranteed.";
};

export const blocksServiceAutomation = record => ['unsupported', 'needs_clarification', 'needs_staff_review'].includes(record?.serviceEligibility?.decision);
