import twilio from "twilio";

const configuredTokens = () =>
  [
    process.env.TWILIO_AUTH_TOKEN,
    process.env.TWILIO_AUTH_TOKEN_NEXT,
    process.env.TWILIO_AUTH_TOKEN_PREVIOUS,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);

export const validateTwilioRequestWithRotation = ({
  signature,
  url,
  params = {},
}) => {
  if (!signature || !url) return false;
  return configuredTokens().some((token) =>
    twilio.validateRequest(token, signature, url, params),
  );
};

export const getTwilioRotationState = () => ({
  primaryConfigured: Boolean(process.env.TWILIO_AUTH_TOKEN),
  nextConfigured: Boolean(process.env.TWILIO_AUTH_TOKEN_NEXT),
  previousConfigured: Boolean(process.env.TWILIO_AUTH_TOKEN_PREVIOUS),
  acceptedTokenCount: configuredTokens().length,
});

export default {
  validateTwilioRequestWithRotation,
  getTwilioRotationState,
};
