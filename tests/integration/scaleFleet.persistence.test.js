import '../../src/models/lead.js';
import '../../src/models/business.js';
import mongoose from 'mongoose';
import { fork } from 'node:child_process';
import path from 'node:path';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
import Job from '../../src/models/smsProcessingJob.js';
import Alert from '../../src/models/alert.js';
import Incident from '../../src/models/opsIncident.js';
import { reconcileExhaustedInboundSmsJobs, completeInboundSmsJob } from '../../src/services/messaging/smsProcessingQueue.service.js';
import { recoverFailedSmsStaffReviews } from '../../src/services/smsStaffReviewRecovery.service.js';
import { setOpsIncident, dispatchOpsEvents } from '../../src/services/opsPaging.service.js';
jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: { emitAlertCreated: jest.fn(), emitAlertUpdated: jest.fn(), emitDashboardRefresh: jest.fn() } }));
beforeAll(async () => { await connectTestDB(); await Promise.all([Job.init(), Alert.init(), Incident.init()]); }, 120000);
afterEach(async () => { delete process.env.OPS_PAGING_ENABLED; if (mongoose.connection.readyState === 1) await clearTestDB(); });
afterAll(async () => { if (mongoose.connection.readyState === 1) await closeTestDB(); });
const oid = () => new mongoose.Types.ObjectId();
const fixture = data => Job.create({ business: oid(), conversation: oid(), lead: oid(), inboundMessage: oid(), ...data });
test('parallel sweepers move one exhausted job to review without changing a live lease', async () => {
  const dead = await fixture({ status: 'processing', attemptCount: 5, maxAttempts: 5, leaseToken: 'old', leaseExpiresAt: new Date(0) });
  const live = await fixture({ status: 'processing', attemptCount: 5, maxAttempts: 5, leaseToken: 'live', leaseExpiresAt: new Date(Date.now() + 60000) });
  const result = await Promise.all(Array.from({ length: 8 }, () => reconcileExhaustedInboundSmsJobs()));
  expect(result.reduce((n, x) => n + x.recovered, 0)).toBe(1);
  expect((await Job.findById(live._id)).status).toBe('processing');
  expect(await completeInboundSmsJob({ jobId: dead._id, leaseToken: 'old' })).toBeNull();
  await recoverFailedSmsStaffReviews(); await recoverFailedSmsStaffReviews();
  expect(await Alert.countDocuments({ dedupeKey: `sms_staff_review_dead:${dead._id}`, actionRequired: true })).toBe(1);
});
test('SIGKILL after final claim is recovered and produces one linked staff review', async () => {
  const job = await fixture({ status: 'retry', attemptCount: 4, maxAttempts: 5, availableAt: new Date(0) });
  const child = fork(path.resolve('tests/fixtures/claim-final-sms.mjs'), [], { env: { ...process.env,
    SCALE_CRASH_TEST_MONGO: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`, NODE_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Crash fixture did not claim')), 20000);
      child.once('message', message => { clearTimeout(timer); message.claimed === String(job._id) ? resolve() : reject(new Error('Wrong claim')); });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited before claim')); });
    });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    const claimed = await Job.findById(job._id); expect(claimed.attemptCount).toBe(5);
    // Advance the sweeper's clock beyond the persisted lease, without sleeping.
    await reconcileExhaustedInboundSmsJobs({ now: new Date(claimed.leaseExpiresAt.getTime() + 1) });
    await recoverFailedSmsStaffReviews();
    expect((await Job.findById(job._id)).status).toBe('dead');
    expect(await Alert.countDocuments({ dedupeKey: `sms_staff_review_dead:${job._id}` })).toBe(1);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
}, 30000);
test('pager retries retain incident identity; workers cannot dispatch the same live claim', async () => {
  process.env.OPS_PAGING_ENABLED = 'true';
  await Promise.all(Array.from({ length: 4 }, () => setOpsIncident({ key: 'review:123', active: true, reason: 'test' })));
  const send = jest.fn().mockResolvedValue(undefined);
  await Promise.all(Array.from({ length: 4 }, () => dispatchOpsEvents({ send })));
  expect(send).toHaveBeenCalledTimes(1); expect(await Incident.countDocuments()).toBe(1);
  await setOpsIncident({ key: 'review:123', active: false, reason: 'closed' });
  await dispatchOpsEvents({ send });
  expect(send.mock.calls.map(([x]) => [x.key, x.action])).toEqual([['review:123', 'trigger'], ['review:123', 'resolve']]);
});
