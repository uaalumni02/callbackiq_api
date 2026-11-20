import * as Sentry from '@sentry/node';
import { sanitizeError } from '../helpers/logging/safeLogger.js';

// An allowlist prevents SDK request context, breadcrumbs, local variables,
// free-form errors and user information from reaching an external service.
export const scrubErrorEvent = event => ({
  event_id: event.event_id,
  timestamp: event.timestamp,
  platform: event.platform,
  level: event.level,
  exception: { values: (event.exception?.values || []).map(value => ({
    type: 'Error',
    value: 'MeekCall operation failed; details redacted',
    stacktrace: { frames: (value.stacktrace?.frames || []).map(frame => ({
      filename: /\/(?:src|build)\/[a-zA-Z/_.-]+\.m?js$/.exec(String(frame.filename || ''))?.[0],
      lineno: frame.lineno,
      colno: frame.colno,
      in_app: frame.in_app,
    })) },
  })) },
});

let trackingInitialized = false;
const initializeErrorTracking = () => {
  if (trackingInitialized) return;
  Sentry.init({ dsn: process.env.SENTRY_DSN, defaultIntegrations: false,
    sendDefaultPii: false, beforeSend: scrubErrorEvent });
  trackingInitialized = true;
};
if (process.env.SENTRY_DSN) initializeErrorTracking();

export const captureExternalError = error => {
  if (!process.env.SENTRY_DSN) return;
  // Reuse the existing logger's error projection, then apply the stricter
  // external-event allowlist in beforeSend regardless of NODE_ENV.
  const sanitized = sanitizeError(error);
  const tracked = new Error(sanitized.message);
  tracked.stack = error?.stack;
  try {
    initializeErrorTracking();
    Sentry.captureException(tracked);
  } catch { /* Tracking must not alter job or request outcomes. */ }
};

export const flushExternalErrors = async () => {
  if (!process.env.SENTRY_DSN) return;
  try { await Sentry.flush(2000); } catch { /* Shutdown must remain bounded. */ }
};

export const trackWorkerFailure = (error, operation) => {
  captureExternalError(error);
  return operation();
};
