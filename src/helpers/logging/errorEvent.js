import { sanitizeError } from './safeLogger.js';

const frameLocation = frame => ({
  filename: /\/(?:src|build)\/[a-zA-Z0-9/_.-]+\.[cm]?js$/.exec(String(frame.filename || '').split(/[?#]/)[0])?.[0],
  lineno: Number.isInteger(frame.lineno) ? frame.lineno : undefined,
  colno: Number.isInteger(frame.colno) ? frame.colno : undefined,
  in_app: frame.in_app,
});

export const scrubErrorEvent = (event, hint = {}) => {
  const original = hint.originalException;
  const identity = sanitizeError(original || { code: event.tags?.code }, { external: true });
  const code = sanitizeError({code: original?.code ?? event.tags?.code}, { external: true }).code;
  const rawValues = event.exception?.values || [];
  const values = rawValues.map((value, index) => {
    const error = sanitizeError({ name: value.type, message: value.value }, { external: true });
    return { type: original && index === rawValues.length - 1 ? identity.name : error.name, value: error.message,
      stacktrace: { frames: (value.stacktrace?.frames || []).map(frameLocation) } };
  });
  const primary = values.at(-1) || { type: identity.name, stacktrace: { frames: [] } };
  const frame = primary.stacktrace.frames.findLast(item => item.filename && item.in_app !== false);
  return {
    event_id: event.event_id, timestamp: event.timestamp, platform: event.platform, level: event.level,
    exception: { values }, tags: code ? { code } : {},
    fingerprint: [primary.type, code || 'none', frame ? `${frame.filename}:${frame.lineno || 0}` : 'unknown:0'],
  };
};
