const MAX_SAMPLES = 500;
const samplesByType = new Map();

const percentile = (values, pct) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index]);
};

export const resetTwilioWebhookLatency = () => {
  samplesByType.clear();
};

export const recordTwilioWebhookLatency = ({
  type = "voice",
  durationMs,
}) => {
  const safeType = String(type || "voice").trim() || "voice";
  const duration = Math.max(0, Number(durationMs) || 0);
  const samples = samplesByType.get(safeType) || [];
  samples.push(duration);
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
  samplesByType.set(safeType, samples);

  return {
    type: safeType,
    count: samples.length,
    latestMs: Math.round(duration),
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    windowSize: MAX_SAMPLES,
  };
};

export const getTwilioWebhookLatencySnapshot = (type = "voice") => {
  const samples = samplesByType.get(type) || [];
  return {
    type,
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    windowSize: MAX_SAMPLES,
  };
};

export default {
  recordTwilioWebhookLatency,
  getTwilioWebhookLatencySnapshot,
  resetTwilioWebhookLatency,
};
