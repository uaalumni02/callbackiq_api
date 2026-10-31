// Pure classification reconciliation; preserves original result-object identity.
export const mergeBookingClassification = ({ parameters, classification, outcome }) => {
  if (outcome.handled && outcome.result) {
    const existing = String(parameters.lead?.serviceNeeded || "").trim();
    const extracted = classification.entities.serviceNeeded;
    outcome.result.serviceNeeded = (existing && existing !== "Unknown" ? existing : extracted) || outcome.result.serviceNeeded;
    const ranks = { low: 0, medium: 1, high: 2, emergency: 3 };
    if ((ranks[classification.entities.urgency] ?? -1) > (ranks[outcome.result.urgency] ?? -1)) outcome.result.urgency = classification.entities.urgency;
  }
  return outcome;
};
