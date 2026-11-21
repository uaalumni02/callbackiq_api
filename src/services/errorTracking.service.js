import * as Sentry from '@sentry/node';
import { sanitizeError } from '../helpers/logging/safeLogger.js';

import { scrubErrorEvent } from '../helpers/logging/errorEvent.js';
export { scrubErrorEvent } from '../helpers/logging/errorEvent.js';

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
  const sanitized = sanitizeError(error, { external: true });
  const tracked = new Error(sanitized.message);
  tracked.name = sanitized.name;
  tracked.stack = error?.stack;
  try {
    initializeErrorTracking();
    Sentry.captureException(tracked, { tags: sanitized.code ? { code: sanitized.code } : {} });
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
