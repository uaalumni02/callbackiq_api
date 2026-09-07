import Joi from "joi";

const text = max => Joi.string().allow("").max(max).truncate();
const schema = Joi.object({
  serviceNeeded: text(200), address: text(500), preferredAppointmentTime: text(200),
  summary: text(1000), reply: text(2000),
  urgency: Joi.string().valid("low", "medium", "high", "emergency"),
  leadQualityScore: Joi.number(), estimatedValue: Joi.number(), confidence: Joi.number(),
  shouldAlertOwner: Joi.boolean(), isInScope: Joi.boolean(),
}).unknown(true);

export const validateAiOutput = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI output must be an object");
  // Refuse type coercion at the trust boundary. Truncate text explicitly so
  // neither providers nor future model changes can persist unbounded fields.
  const bounded = { ...value };
  for (const [key, max] of Object.entries({ serviceNeeded: 200, address: 500, preferredAppointmentTime: 200, summary: 1000, reply: 2000 })) {
    if (typeof bounded[key] === "string") bounded[key] = bounded[key].slice(0, max);
  }
  if (typeof bounded.urgency === "string" && !["low", "medium", "high", "emergency"].includes(bounded.urgency)) bounded.urgency = "medium";
  const result = schema.validate(bounded, { convert: false });
  if (result.error) throw new Error("AI output failed application validation");
  return result.value;
};
export const parseAiOutput = text => validateAiOutput(JSON.parse(String(text || "").trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")));
