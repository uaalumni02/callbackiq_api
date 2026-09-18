import Alert from '../../src/models/alert.js';
import SocketService from '../../src/services/socket.service.js';
import { escalateOverdueInterventions } from '../../src/services/interventionEscalation.service.js';
jest.mock('../../src/models/alert.js', () => ({ __esModule: true, default: { find: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: { emitAlertUpdated: jest.fn(), emitDashboardRefresh: jest.fn() } }));
beforeEach(() => jest.clearAllMocks());
test('escalates an overdue unacknowledged alert with an atomic recheck', async () => {
 const query = { sort: () => query, limit: () => query, select: () => query, lean: async () => [{ _id: 'a', business: 'b' }] };
 Alert.find.mockReturnValue(query);
 Alert.findOneAndUpdate.mockResolvedValue({ _id: 'a', priority: 'critical' });
 const now = new Date();
 expect(await escalateOverdueInterventions({ now })).toEqual({ escalated: 1 });
 expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: 'a', business: 'b', acknowledgedAt: null, resolvedAt: null, 'metadata.reviewEscalatedAt': { $exists: false } }), expect.objectContaining({ $set: { priority: 'critical', 'metadata.reviewEscalatedAt': now } }), expect.any(Object));
 expect(SocketService.emitAlertUpdated).toHaveBeenCalledTimes(1);
});
test('does not notify when staff acknowledges between scan and update', async () => {
 const query = { sort: () => query, limit: () => query, select: () => query, lean: async () => [{ _id: 'a', business: 'b' }] };
 Alert.find.mockReturnValue(query); Alert.findOneAndUpdate.mockResolvedValue(null);
 expect(await escalateOverdueInterventions()).toEqual({ escalated: 0 });
 expect(SocketService.emitAlertUpdated).not.toHaveBeenCalled();
});
test('repairs missing deadlines using original creation time, then escalates overdue work',async()=>{
 const createdAt=new Date('2026-09-18T10:00:00Z'),now=new Date('2026-09-18T12:00:00Z');
 const query={sort:()=>query,limit:()=>query,select:()=>query,lean:async()=>[{_id:'a',business:'b',dueAt:null,priority:'high',createdAt}]};
 Alert.find.mockReturnValue(query);Alert.findOneAndUpdate.mockResolvedValue({_id:'a'});
 expect(await escalateOverdueInterventions({now})).toEqual({escalated:1});
 expect(Alert.findOneAndUpdate.mock.calls[0][1].$set.dueAt.getTime()).toBeLessThan(now.getTime());
 expect(Alert.findOneAndUpdate.mock.calls[1][0]).toMatchObject({acknowledgedAt:null,resolvedAt:null,dueAt:{$lte:now,$ne:null}});
});
test('a concurrently acknowledged missing-deadline alert is not reopened',async()=>{
 const query={sort:()=>query,limit:()=>query,select:()=>query,lean:async()=>[{_id:'a',business:'b',dueAt:null,priority:'high',createdAt:new Date(0)}]};
 Alert.find.mockReturnValue(query);Alert.findOneAndUpdate.mockResolvedValue(null);
 expect(await escalateOverdueInterventions()).toEqual({escalated:0});expect(SocketService.emitAlertUpdated).not.toHaveBeenCalled();
});
