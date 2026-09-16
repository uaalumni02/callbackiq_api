import Job from '../../src/models/smsProcessingJob.js';
import { reconcileExhaustedInboundSmsJobs } from '../../src/services/messaging/smsProcessingQueue.service.js';
import { sendOpsEvent } from '../../src/services/opsPaging.service.js';
import { validateScaleProfile } from '../../src/config/scaleProfile.js';
afterEach(() => { jest.restoreAllMocks(); delete process.env.PAGERDUTY_ROUTING_KEY; });
test('exhausted recovery is bounded, fenced and never sends a provider operation', async () => {
  const now = new Date();
  jest.spyOn(Job, 'findOneAndUpdate').mockResolvedValueOnce({ _id: 'dead' }).mockResolvedValue(null);
  expect(await reconcileExhaustedInboundSmsJobs({ now })).toEqual({ recovered: 1 });
  const [filter, update] = Job.findOneAndUpdate.mock.calls[0];
  expect(filter.$expr).toEqual({ $gte: ['$attemptCount', '$maxAttempts'] });
  expect(filter.$or[0]).toEqual({ status: 'processing', leaseExpiresAt: { $lte: now } });
  expect(update.$set).toMatchObject({ status: 'dead', leaseToken: '', 'result.staffReviewAlertRecorded': false });
});
test('pager event has a stable dedupe identity and excludes customer data', async () => {
  process.env.PAGERDUTY_ROUTING_KEY = 'test-routing-key';
  const fetcher = jest.fn().mockResolvedValue({ status: 202, json: async () => ({ status: 'success' }) });
  await sendOpsEvent({ key: 'review:123', action: 'trigger', reason: 'unacknowledged_customer_review', fetcher });
  const [url, request] = fetcher.mock.calls[0]; const body = JSON.parse(request.body);
  expect(url).toBe('https://events.pagerduty.com/v2/enqueue');
  expect(body.dedup_key).toContain('review:123'); expect(body.payload.severity).toBe('critical');
  expect(request.signal).toBeDefined();
  await sendOpsEvent({ key: 'review:123', action: 'resolve', reason: 'closed', fetcher });
  expect(JSON.parse(fetcher.mock.calls[1][1].body).dedup_key).toBe(body.dedup_key);
});
test('pager rejects unsuccessful acceptance and does not treat HTTP 200 as queued', async () => {
  process.env.PAGERDUTY_ROUTING_KEY = 'test-routing-key';
  await expect(sendOpsEvent({ key: 'key', action: 'trigger', reason: 'test', fetcher: async () => ({ status: 200 }) })).rejects.toMatchObject({ code: 'OPS_HTTP_200' });
});
const valid = () => ({ SCALE_PROFILE:'business-1000-voice-350', PROCESS_ROLE:'voice', SCALE_TARGET_BUSINESSES:'1001', SCALE_TARGET_VOICE:'350',
  SCALE_VOICE_REPLICAS:'6', API_INSTANCE_COUNT:'4', SCALE_SMS_REPLICAS:'26', SCALE_SMS_REQUIRED_REPLICAS:'26', SCALE_TARGET_SMS_RPS:'200', SCALE_SMS_PROCESSING_P95_MS:'2000', SCALE_SMS_TARGET_UTILIZATION:'.65', SMS_PROCESSING_CONCURRENCY:'25', SCALE_CAPACITY_PLAN_SHA256:'a'.repeat(64), SCALE_CAPACITY_PROVIDER_MODE:'live', VOICE_INSTANCE_MAX_SESSIONS:'100', VOICE_INSTANCE_MAX_AI_TURNS:'75', VOICE_FLEET_MAX_SESSIONS:'450', VOICE_FLEET_MAX_AI_TURNS:'400',
  PROVIDER_VOICE_SESSION_QUOTA:'450', PROVIDER_AI_CONCURRENT_QUOTA:'2000', SCALE_COMBINED_AI_CONCURRENCY:'1075', SCALE_MONGO_CONNECTION_BUDGET:'2000', SCALE_MONGO_DECLARED_CONNECTIONS:'1200', REDIS_URL:'redis://127.0.0.1:6379', SCALE_CACHE_NAMESPACE:'staging', SOCKET_REDIS_REQUIRED:'true', COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED:'true',
  VOICE_RELAY_ENABLED:'true', STAFF_NOTIFICATION_EMAIL_ENABLED:'true', GMAIL_ADDRESS:'ops@example.test', GMAIL_PASSWORD:'test', OPS_PAGING_ENABLED:'true', PAGERDUTY_ROUTING_KEY:'test', DEPLOY_TERMINATION_GRACE_MS:'660000' });
test('350-session profile reserves N-1 turn capacity and enforces provider budgets', () => {
  expect(validateScaleProfile(valid()).errors).toEqual([]);
  for (const change of [{ SCALE_VOICE_REPLICAS:'4' }, { PROVIDER_AI_CONCURRENT_QUOTA:'100' }, { SCALE_MONGO_CONNECTION_BUDGET:'100' }, { DEPLOY_TERMINATION_GRACE_MS:'30000' }]) expect(validateScaleProfile({ ...valid(), ...change }).errors.length).toBeGreaterThan(0);
});
test('profile validates role separation and required notification dependencies', () => {
 for (const change of [{ SCALE_PROFILE:'unknown' }, { PROCESS_ROLE:'api', VOICE_RELAY_ENABLED:'true' }, { VOICE_RELAY_ENABLED:'false' },
   { VOICE_FLEET_MAX_SESSIONS:'100' }, { RECOVERY_SMS_ASYNC_ENABLED:'false' }, { REDIS_URL:'' }, { STAFF_NOTIFICATION_EMAIL_ENABLED:'false' },
   { OPS_PAGING_ENABLED:'false' }, { COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED:'' }]) expect(validateScaleProfile({ ...valid(), ...change }).errors.length).toBeGreaterThan(0);
 const { assertScaleProfile } = require('../../src/config/scaleProfile.js');
 expect(assertScaleProfile(valid()).enabled).toBe(true);
 expect(() => assertScaleProfile({ ...valid(), SCALE_VOICE_REPLICAS:'1' })).toThrow('Invalid scale profile');
});
