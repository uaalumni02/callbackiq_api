import * as Sentry from '@sentry/node';
import { scrubErrorEvent, captureExternalError } from '../../src/services/errorTracking.service.js';
import { notifyDeadJob, persistAlertAndNotifyOperations } from '../../src/services/operationsAlert.service.js';

jest.mock('@sentry/node', () => ({init: jest.fn(), captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true)}));

afterEach(() => { delete process.env.SENTRY_DSN; delete process.env.OPS_ALERT_WEBHOOK_URL; jest.restoreAllMocks(); });
test('external events contain no customer content, URL, token, or local variables', () => {
  const event = scrubErrorEvent({ request: {headers: {authorization: 'secret'}},
    user: {email: 'customer@example.com'}, breadcrumbs: [{message: '+14045550100'}],
    exception: {values: [{value: 'customer text', type: 'secret', stacktrace: {frames: [{filename: '/app/src/server.js', lineno: 12, vars: {token: 'secret'}}]}}]} });
  expect(JSON.stringify(event)).not.toMatch(/secret|customer text|customer@|14045550100/);
  expect(event.exception.values[0].stacktrace.frames[0].filename).toBe('/src/server.js');
});
test('disabled error tracking is inert', () => {
  expect(() => captureExternalError(new Error('test'))).not.toThrow();
});
test('dead-job payload is bounded and transport failure is swallowed', async () => {
  process.env.OPS_ALERT_WEBHOOK_URL = 'https://ops.example.test/alerts';
  const transport = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
  notifyDeadJob({ jobType: 'sms', id: 'job', businessId: 'business', errorCode: 'customer secret text' });
  await new Promise(resolve => setImmediate(resolve));
  const [, options] = transport.mock.calls[0];
  expect(JSON.parse(options.body)).toEqual({jobType: 'sms', id: 'job', businessId: 'business', errorCode: 'PROCESSING_FAILED'});
  expect(options.signal).toBeDefined();
});
test('disabled notifications do not call fetch', () => {
  const transport = jest.spyOn(global, 'fetch');
  notifyDeadJob({});
  expect(transport).not.toHaveBeenCalled();
});

test('an existing dedupe identity never triggers a second operations notification', async () => {
  process.env.OPS_ALERT_WEBHOOK_URL = 'https://ops.example.test/alerts';
  const transport = jest.spyOn(global, 'fetch').mockResolvedValue({ok: true});
  const payload = {business: 'business', dedupeKey: 'sms_processing_dead:job', metadata: {errorCode: 'RETRY_EXHAUSTED'}};
  const insert = jest.fn().mockResolvedValueOnce({_id: 'alert'}).mockRejectedValueOnce(Object.assign(new Error('duplicate'), {code: 11000}));
  await persistAlertAndNotifyOperations(insert, payload);
  await expect(persistAlertAndNotifyOperations(insert, payload)).rejects.toMatchObject({code: 11000});
  await new Promise(resolve => setImmediate(resolve));
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({jobType: 'sms', id: 'job', businessId: 'business', errorCode: 'RETRY_EXHAUSTED'});
});

test('tracking initializes when a DSN is supplied after the module was imported', () => {
  process.env.SENTRY_DSN = 'synthetic-dsn';
  captureExternalError(new Error('synthetic error'));
  expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
    dsn: 'synthetic-dsn', beforeSend: scrubErrorEvent, sendDefaultPii: false,
  }));
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
});
