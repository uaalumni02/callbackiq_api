import { createHash } from "node:crypto";

export const BUSINESS_NUMBER = "+12025550123";
export const TRANSFER_NUMBER = "+14045559999";

const sid = (prefix, namespace, index) =>
  `${prefix}${createHash("sha256")
    .update(`callbackiq-voice-concurrency:${namespace}:${index}`)
    .digest("hex")
    .slice(0, 32)}`;

export const callSidFor = (index, namespace = "call") =>
  sid("CA", namespace, index);

export const providerSessionIdFor = (index, namespace = "session") =>
  sid("VX", namespace, index);

export const callerFor = (index) =>
  `+1404${String(5551000 + index).padStart(7, "0")}`;

export const buildSyntheticCall = ({
  index,
  namespace = "default",
  from = callerFor(index),
  to = BUSINESS_NUMBER,
  service = "plumbing",
} = {}) => ({
  index,
  from,
  to,
  callSid: callSidFor(index, `${namespace}:call`),
  providerSessionId: providerSessionIdFor(index, `${namespace}:session`),
  sentinel: `VOICE_${namespace.toUpperCase()}_${String(index).padStart(2, "0")}_SENTINEL`,
  service,
});
