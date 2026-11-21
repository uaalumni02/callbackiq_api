import * as Sentry from '@sentry/node';
import { scrubErrorEvent, captureExternalError } from '../../src/services/errorTracking.service.js';
import { notifyDeadJob, persistAlertAndNotifyOperations } from '../../src/services/operationsAlert.service.js';

jest.mock('@sentry/node', () => ({init: jest.fn(), captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true)}));

beforeEach(() => jest.clearAllMocks());
afterEach(() => { delete process.env.SENTRY_DSN; delete process.env.OPS_ALERT_WEBHOOK_URL; jest.restoreAllMocks(); });
test('external events contain no customer content, URL, token, or local variables', () => {
  const event = scrubErrorEvent({ request: {headers: {authorization: 'secret'}},
    user: {email: 'customer@example.com'}, breadcrumbs: [{message: '+14045550100'}],
    exception: {values: [{value: 'Insert failed payload={"body":"customer text","token":"secret"}', type: 'MongoServerError', stacktrace: {frames: [{filename: '/app/src/server.js', lineno: 12, vars: {token: 'secret'}}]}}]} });
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

const diagnosticEvent = (error, filename='/app/src/services/book2.js', lineno=42) => ({
  request:{headers:{authorization:'private request'},body:'private body'}, user:{ip_address:'private IP'},
  breadcrumbs:[{message:'private breadcrumb'}], extra:{responseBody:'private response'}, tags:{code:error.code,body:'private tag'},
  exception:{values:[{type:error.name,value:error.message,stacktrace:{frames:[{filename,lineno,in_app:true,vars:{phone:'+14045550100'},context_line:'private source'}]}}]},
});
test('different constructors retain distinct useful messages and stable grouping without SDK context', () => {
  class MongoServerError extends Error {}
  const mongo=Object.assign(new MongoServerError('Insert failed for +14045550100 Bearer abc.private.token'),{code:11000});
  const type=new TypeError('Cannot read booking status');
  const first=scrubErrorEvent(diagnosticEvent(mongo),{originalException:mongo});
  const second=scrubErrorEvent(diagnosticEvent(type),{originalException:type});
  expect(first.exception.values[0]).toMatchObject({type:'MongoServerError',value:expect.stringContaining('Insert failed')});
  expect(second.exception.values[0]).toMatchObject({type:'TypeError',value:'Cannot read booking status'});
  expect(first.exception.values[0].value).not.toBe(second.exception.values[0].value);
  expect(first.tags).toEqual({code:'11000'});
  expect(first.fingerprint).toEqual(['MongoServerError','11000','/src/services/book2.js:42']);
  expect(second.fingerprint).not.toEqual(first.fingerprint);
  expect(scrubErrorEvent(diagnosticEvent(mongo),{originalException:mongo}).fingerprint).toEqual(first.fingerprint);
  expect(JSON.stringify(first)).not.toMatch(/14045550100|abc.private.token|private (request|body|IP|breadcrumb|response|tag|source)/);
  for(const field of ['request','user','breadcrumbs','extra'])expect(first).not.toHaveProperty(field);
  expect(first.exception.values[0].stacktrace.frames[0]).not.toHaveProperty('vars');
});
test('external messages redact payloads, credentials and URL secrets in every environment and cap diagnostic length', () => {
  const error=Object.assign(new Error('Request failed https://user:pass@example.test/api?token=secret#customer payload={"body":"private customer text"} password=private-password; '+ 'x'.repeat(500)),{code:'ETIMEDOUT'});
  const result=scrubErrorEvent(diagnosticEvent(error,'/app/src/jobs/worker2.js?token=private#secret'),{originalException:error});
  const message=result.exception.values[0].value;
  expect(message).toContain('Request failed https://example.test/api');
  expect(message.length).toBeLessThanOrEqual(300);
  expect(JSON.stringify(result)).not.toMatch(/user:pass|token=|#secret|private|password/);
});
test('capture sends the sanitized original error name and operational code tag', () => {
  process.env.SENTRY_DSN='synthetic-dsn';
  const error=Object.assign(new TypeError('Booking failed for +14045550100 Bearer private-token'),{code:'BOOKING_READ'});
  captureExternalError(error);
  const [tracked,options]=Sentry.captureException.mock.calls[0];
  expect(tracked.name).toBe('TypeError');
  expect(tracked.message).toContain('Booking failed');
  expect(tracked.message).not.toMatch(/14045550100|private-token/);
  expect(options).toEqual({tags:{code:'BOOKING_READ'}});
});
