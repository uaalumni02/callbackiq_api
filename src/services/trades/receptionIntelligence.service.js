/**
 * MeekCall trade-specific reception guidance, v1.
 *
 * Advisory prompt context ONLY. A business's active ServiceOffering catalog,
 * service-area and scheduling permissions remain the authority. Neither this
 * data nor a language-model response authorizes a quote, diagnosis, booking,
 * emergency dispatch, or staff response-time commitment.
 *
 * Keep the object small and deterministic because it is sent to a model.
 */
export const RECEPTION_GUIDANCE_VERSION = 1;

const BASE = Object.freeze({
  staffFollowUp: 'Collect an actionable request for staff review; do not offer a live phone transfer after AI answers.',
  booking: 'Requested timing is a preference, not a confirmed appointment. Only the scheduling service can confirm.',
  safety: 'For imminent danger, follow the existing deterministic safety policy and advise appropriate emergency services. Do not troubleshoot hazardous repairs.',
  pricing: 'Do not invent prices, free estimates, technician arrival times, or insurance coverage.',
});

export const TRADE_RECEPTION_GUIDANCE = Object.freeze({
  plumbing: Object.freeze({
    label: 'Plumbing',
    intake: ['What is leaking, blocked, or not working?', 'Is damage active or contained?', 'What is the service address?'],
    prioritySignals: ['active flooding', 'sewage backup', 'loss of water'],
    caution: 'Escalate danger involving electricity, gas odor, sewage exposure or uncontrolled flooding; do not guide dangerous repairs.',
  }),
  hvac: Object.freeze({
    label: 'Heating and cooling',
    intake: ['Is heating or cooling affected?', 'Which system is affected?', 'Does the equipment run?', 'What is the service address?'],
    prioritySignals: ['extreme indoor temperature', 'vulnerable occupants', 'no heat in cold weather'],
    caution: 'Never diagnose combustion, refrigerant or electrical faults remotely. Handle carbon-monoxide concerns through emergency safety rules.',
  }),
  electrical: Object.freeze({
    label: 'Electrical',
    intake: ['What area or device is affected?', 'Is there sparking, smoke, burning smell, or exposed wiring?', 'What is the service address?'],
    prioritySignals: ['sparking', 'smoke', 'burning smell', 'exposed live wires'],
    caution: 'For possible fire or live electrical hazards, prioritize emergency guidance; never instruct the caller to handle wiring.',
  }),
  roofing: Object.freeze({
    label: 'Roofing',
    intake: ['Is water entering now, or was the damage observed earlier?', 'Was there a recent storm?', 'What is the property address?'],
    prioritySignals: ['active interior leak', 'storm structural damage'],
    caution: 'Do not advise climbing or inspecting an unstable roof. Route dangerous structural situations to emergency guidance.',
  }),
  restoration: Object.freeze({
    label: 'Damage restoration',
    intake: ['Is the damage from water, fire, smoke, sewage, or another source?', 'Is it still spreading?', 'What areas are affected?'],
    prioritySignals: ['active water intrusion', 'sewage contamination', 'ongoing fire or smoke'],
    caution: 'Do not represent the business as an emergency responder, or guarantee insurer coverage or immediate dispatch.',
  }),
  garage_door: Object.freeze({
    label: 'Garage doors',
    intake: ['Is the door open, closed, or partly open?', 'Is the concern with the opener, spring, cable, or door?', 'What is the service address?'],
    prioritySignals: ['door trapped open', 'vehicle trapped', 'damaged spring or cable'],
    caution: 'Never provide tension-spring, cable-release, or force-open instructions.',
  }),
  locksmith: Object.freeze({
    label: 'Locksmith',
    intake: ['Is this a home, commercial property, or vehicle?', 'Is it a lockout, rekey, repair, or installation?', 'What is the service address?'],
    prioritySignals: ['child or vulnerable person locked in', 'unsafe lockout conditions'],
    caution: 'Do not provide lock-bypass instructions or claim identity/ownership has been verified; technician must independently verify authorization.',
  }),
  landscaping: Object.freeze({
    label: 'Landscaping',
    intake: ['Is this maintenance, installation, tree work, drainage, or cleanup?', 'Is the property residential or commercial?', 'Is this a one-time or recurring project?'],
    prioritySignals: ['fallen tree blocking essential access', 'active drainage threatening property'],
    caution: 'Recurring contracts, hazardous trees and commercial scopes need the configured estimate/review workflow, not invented pricing.',
  }),
});

const ALIASES = Object.freeze({
  plumber: 'plumbing', plumbing: 'plumbing',
  heating: 'hvac', cooling: 'hvac', air_conditioning: 'hvac', hvac: 'hvac',
  electrician: 'electrical', electric: 'electrical', electrical: 'electrical',
  roof: 'roofing', roofer: 'roofing', roofing: 'roofing',
  water_damage: 'restoration', mitigation: 'restoration', restoration: 'restoration',
  garage: 'garage_door', garage_door: 'garage_door', garage_doors: 'garage_door',
  lock: 'locksmith', locksmith: 'locksmith',
  lawn_care: 'landscaping', lawn: 'landscaping', landscaping: 'landscaping',
});

export const normalizeReceptionTrade = (value) => {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : '';
};

/** Never infer that the business offers a service based on this metadata. */
export function getTradeReceptionGuidance({ businessType = '', services = [] } = {}) {
  const explicit = normalizeReceptionTrade(businessType);
  const fromCatalog = Array.isArray(services)
    ? services.filter(service => service?.active !== false).map(service => normalizeReceptionTrade(service?.category)).filter(Boolean)
    : [];
  const trades = [...new Set([explicit, ...fromCatalog].filter(Boolean))].slice(0, 8);
  return {
    version: RECEPTION_GUIDANCE_VERSION,
    policy: BASE,
    // These are suggested question topics, NOT a required sequential form.
    // Do not repeat questions for facts already provided by the customer.
    profiles: trades.map(trade => ({ trade, ...TRADE_RECEPTION_GUIDANCE[trade] })),
    allowedCommitments: 'None beyond the existing authoritative scheduling and notification tools',
  };
}

export default getTradeReceptionGuidance;
