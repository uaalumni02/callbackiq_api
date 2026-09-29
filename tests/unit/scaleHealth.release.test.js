import Sms from '../../src/models/smsProcessingJob.js';
import Work from '../../src/models/webhookWork.js';
import Heartbeat from '../../src/models/processHeartbeat.js';
import Incident from '../../src/models/opsIncident.js';
import Notification from '../../src/models/staffNotificationJob.js';
import { readScaleHealth } from '../../src/services/scaleHealth.service.js';
const query = result => ({ sort: () => query(result), select: () => query(result), maxTimeMS: () => query(result), lean: async () => result });
beforeEach(() => {
 jest.spyOn(Sms, 'findOne').mockImplementation(() => query(null));
 jest.spyOn(Work, 'findOne').mockImplementation(() => query(null));
 jest.spyOn(Heartbeat, 'aggregate').mockReturnValue({ option: async () => [] });
 jest.spyOn(Incident, 'countDocuments').mockReturnValue({ maxTimeMS: async () => 0 });
 jest.spyOn(Notification, 'aggregate').mockReturnValue({ option: () => Promise.resolve([]) });
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.SCALE_PROFILE; });
test('queue age reflects original receipt time rather than the latest retry', async () => {
 const now = new Date(); Sms.findOne.mockImplementation(() => query({ createdAt: new Date(now - 61000) }));
 expect(await readScaleHealth({ now })).toMatchObject({ healthy: false, smsOldestAgeMs: 61000 });
});
test('missing workers cannot appear healthy in the scale profile', async () => {
 process.env.SCALE_PROFILE = 'business-1000-voice-350';
 const result = await readScaleHealth();
 expect(result.healthy).toBe(false); expect(result.missingRoles).toContain('worker-ops');
});
test('failed pager is unhealthy even with empty queues', async () => {
 Incident.countDocuments.mockReturnValue({ maxTimeMS: async () => 1 });
 expect(await readScaleHealth()).toMatchObject({ healthy: false, failedPages: 1 });
});

test('fleet health reports unique deployment identities and exposes unrecorded older workers', async () => {
 Heartbeat.aggregate.mockReturnValue({ option: async () => [
  { _id: 'api', count: 2, releases: ['release'], capacityPlans: ['plan'], images: ['image'] },
  { _id: 'worker-sms', count: 2, releases: ['release'], capacityPlans: ['plan'], images: ['image'] },
  { _id: 'voice', count: 1, releases: ['release'] },
 ] });
 expect(await readScaleHealth()).toMatchObject({capacityPlans:['plan','unrecorded'],images:['image','unrecorded']});
});

test('unresolved failed approval email is unhealthy even with empty queues', async () => {
 Notification.aggregate.mockReturnValue({ option: () => Promise.resolve([{count:1}]) });
 expect(await readScaleHealth()).toMatchObject({ healthy:false, uncertainEmail:1 });
 const pipeline=Notification.aggregate.mock.calls[0][0];
 expect(pipeline[1].$lookup.pipeline[0].$match).toMatchObject({actionRequired:true,acknowledgedAt:null,resolvedAt:null});
});
