import Incident from '../../src/models/opsIncident.js';
import Alert from '../../src/models/alert.js';
import { setOpsIncident, dispatchOpsEvents, reconcileOpsAlerts } from '../../src/services/opsPaging.service.js';
jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: { emitAlertUpdated: jest.fn() } }));
const chain = result => ({ sort: () => chain(result), limit: () => chain(result), select: () => chain(result), lean: async () => result });
beforeEach(() => {
 process.env.OPS_PAGING_ENABLED = 'true';
 jest.spyOn(Incident, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
 jest.spyOn(Incident, 'findOneAndUpdate').mockResolvedValue(null);
 jest.spyOn(Incident, 'find').mockImplementation(() => chain([]));
 jest.spyOn(Incident, 'findById').mockImplementation(() => chain(null));
 jest.spyOn(Alert, 'find').mockImplementation(() => chain([]));
 jest.spyOn(Alert, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
 jest.spyOn(Alert, 'findOneAndUpdate').mockResolvedValue(null);
 jest.spyOn(Alert, 'exists').mockResolvedValue(null);
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.OPS_PAGING_ENABLED; });
const job = { _id: 'review:1', alert: 'a', business: 'b', revision: 0, attempts: 1, desiredAction: 'trigger', reason: 'overdue' };
test('disabled paging neither writes nor sends', async () => {
 delete process.env.OPS_PAGING_ENABLED;
 await setOpsIncident({ key: 'a', active: true }); await reconcileOpsAlerts();
 expect(await dispatchOpsEvents()).toEqual({ processed: 0 }); expect(Incident.updateOne).not.toHaveBeenCalled();
});
test('idempotent insertion tolerates duplicate key and does not reset existing accepted state', async () => {
 Incident.updateOne.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
 await setOpsIncident({ key: 'a', active: true, reason: 'overdue' });
 expect(Incident.updateOne.mock.calls[0][1].$set).toBeUndefined();
 expect(Incident.updateOne.mock.calls[1][0]).toEqual({ _id: 'a', desiredAction: { $ne: 'trigger' } });
});
test('provider timeout retries the same key with fenced state and capped backoff', async () => {
 Incident.findOneAndUpdate.mockResolvedValueOnce(job);
 const send = jest.fn().mockRejectedValue(new Error('timeout'));
 await dispatchOpsEvents({ send });
 expect(send).toHaveBeenCalledWith({ key: job._id, action: 'trigger', reason: 'overdue' });
 expect(Incident.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: job._id, revision: 0, status: 'sending' }), expect.objectContaining({ $set: expect.objectContaining({ status: 'pending', lastErrorCode: 'OPS_NETWORK_ERROR' }) }));
});
test('provider failure reaches operator-visible terminal status after bounded retries', async () => {
 Incident.findOneAndUpdate.mockResolvedValueOnce({ ...job, attempts: 20 });
 await dispatchOpsEvents({ send: async () => { throw Object.assign(new Error('denied'), { code: 'OPS_HTTP_403' }); } });
 expect(Incident.updateOne.mock.calls[0][1].$set.status).toBe('failed');
});
test('acknowledged review requests resolve using the existing incident identity', async () => {
 Incident.find.mockImplementation(() => chain([job]));
 await reconcileOpsAlerts();
 expect(Incident.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: job._id, desiredAction: { $ne: 'resolve' } }), expect.objectContaining({ $set: expect.objectContaining({ desiredAction: 'resolve' }) }));
 expect(Alert.updateOne).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ acknowledgedAt: expect.anything() }) }));
});
test('new overdue alert is enqueued and a crash before UI publication is repairable', async () => {
 Alert.find.mockImplementation(() => chain([{ _id:'a', business:'b' }]));
 await reconcileOpsAlerts();
 expect(Alert.updateOne).toHaveBeenCalled();
 Incident.find.mockImplementation(() => chain([{ _id: 'review:a' }]));
 Incident.findById.mockImplementation(() => chain({ _id:'review:a', alert:'a', business:'b', revision:2, status:'accepted', desiredAction:'trigger' }));
 Alert.findOneAndUpdate.mockResolvedValue({ _id:'a' });
 await dispatchOpsEvents({ send: jest.fn() });
 expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ business:'b' }), expect.objectContaining({ $set: { 'metadata.opsNotification': expect.objectContaining({ status:'accepted', revision:2 }) } }), expect.anything());
});
test('ordinary database insertion failure is surfaced', async () => {
 Incident.updateOne.mockRejectedValueOnce(new Error('database unavailable'));
 await expect(setOpsIncident({ key:'a', active:true })).rejects.toThrow('database unavailable');
});

test('medium approval failures and expired notices are eligible for operations paging', async () => {
 process.env.OPS_PAGING_ENABLED='true';
 Alert.find.mockReturnValue({sort:()=>({limit:()=>({select:()=>({lean:async()=>[]})})})});
 Incident.find.mockReturnValue({sort:()=>({limit:()=>({lean:async()=>[]})})});
 await reconcileOpsAlerts();
 const filter=Alert.find.mock.calls.at(-1)[0];
 expect(filter.$and[0].$or).toContainEqual({'metadata.approvalRequest':true});
 expect(filter.$or).toContainEqual({'metadata.staffNotification.expired.status':{$in:['failed','uncertain']}});
 expect(filter.$and[1].$or).toContainEqual({'metadata.opsNotification.action':'resolve'});
});
