const FACT_KEYS = Object.freeze([
  "businessHours",
  "approvedServices",
  "serviceAreas",
  "pricing",
  "schedulingRules",
  "availabilityPolicy",
  "emergencyServiceAvailable",
  "financing",
  "warrantyPolicy",
  "cancellationPolicy",
  "brandsServiced",
  "diagnosticFee",
]);

const REQUIRED_FOR_AI_READINESS = Object.freeze([
  "businessHours",
  "approvedServices",
  "serviceAreas",
  "pricing",
  "schedulingRules",
  "availabilityPolicy",
]);

const clone = (value) => {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
};

export const buildVerifiedFactUpdate = ({
  facts,
  actorId,
  source = "owner",
  now = new Date(),
}) => {
  const update = {};

  for (const key of FACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(facts || {}, key)) continue;

    const entry = facts[key];
    const verified = entry?.verified === true;

    update[`aiKnowledge.verifiedFacts.${key}`] = {
      value: clone(entry?.value),
      verified,
      verifiedAt: verified ? now : null,
      verifiedBy: verified ? actorId : null,
      source,
    };
  }

  update["aiKnowledge.lastReviewedAt"] = now;
  update["aiKnowledge.lastReviewedBy"] = actorId;

  return update;
};

export const getVerifiedBusinessFacts = (business) => {
  const facts = business?.aiKnowledge?.verifiedFacts || {};
  const result = {};

  for (const key of FACT_KEYS) {
    const entry = facts[key];
    if (entry?.verified === true && entry.value !== null) {
      result[key] = clone(entry.value);
    }
  }

  return result;
};

export const getBusinessFactsReadiness = (business) => {
  const verified = getVerifiedBusinessFacts(business);
  const missing = REQUIRED_FOR_AI_READINESS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(verified, key),
  );

  return {
    ready: missing.length === 0,
    verifiedCount: Object.keys(verified).length,
    totalTrackedFacts: FACT_KEYS.length,
    requiredCount: REQUIRED_FOR_AI_READINESS.length,
    missingRequiredFacts: missing,
  };
};

export const getOwnerSafeBusinessFacts = (business) => {
  const facts = business?.aiKnowledge?.verifiedFacts || {};

  return Object.fromEntries(
    FACT_KEYS.map((key) => [
      key,
      {
        value: clone(facts[key]?.value ?? null),
        verified: facts[key]?.verified === true,
        verifiedAt: facts[key]?.verifiedAt || null,
        source: facts[key]?.source || "owner",
      },
    ]),
  );
};

export { FACT_KEYS, REQUIRED_FOR_AI_READINESS };
