// Deterministic urgency preservation extracted verbatim from SMS intake.
export const VALID_URGENCIES = new Set(["low", "medium", "high", "emergency"]);
export const SMS_URGENCY_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  emergency: 3,
});
export const preserveHigherUrgency = (current, candidate) => {
  const currentValue = VALID_URGENCIES.has(String(current || ""))
    ? String(current)
    : "medium";
  const candidateValue = VALID_URGENCIES.has(String(candidate || ""))
    ? String(candidate)
    : "";
  if (!candidateValue) return currentValue;
  return SMS_URGENCY_RANK[candidateValue] > SMS_URGENCY_RANK[currentValue]
    ? candidateValue
    : currentValue;
};
