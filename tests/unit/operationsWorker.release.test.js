import { maintainStaffReviewRecords } from '../../src/services/staffReviewReconciliation.service.js';
jest.mock('../../src/services/staffReviewReconciliation.service.js', () => ({ maintainStaffReviewRecords: jest.fn().mockResolvedValue({ scanned: 0 }) }));
import { startOperationsWorker, stopOperationsWorker } from '../../src/workers/operations.worker.js';
import { readScaleHealth } from '../../src/services/scaleHealth.service.js';
import { dispatchOpsEvents, setOpsIncident } from '../../src/services/opsPaging.service.js';
import { recoverFailedSmsStaffReviews } from '../../src/services/smsStaffReviewRecovery.service.js';
jest.mock('../../src/services/scaleHealth.service.js', () => ({ readScaleHealth: jest.fn() }));
jest.mock('../../src/services/opsPaging.service.js', () => ({ reconcileOpsAlerts: jest.fn(), dispatchOpsEvents: jest.fn(), setOpsIncident: jest.fn() }));
jest.mock('../../src/services/smsStaffReviewRecovery.service.js', () => ({ recoverFailedSmsStaffReviews: jest.fn(), recoverFailedWebhookReviews: jest.fn() }));
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({ logOperationalError: jest.fn() }));
beforeEach(() => { jest.useFakeTimers(); readScaleHealth.mockResolvedValue({ healthy:false }); });
afterEach(async () => { await stopOperationsWorker(); jest.clearAllMocks(); jest.useRealTimers(); });
test('independent operations loop recovers work and dispatches through bounded lanes', async () => {
 startOperationsWorker(); startOperationsWorker(); await jest.advanceTimersByTimeAsync(1);
 expect(maintainStaffReviewRecords).toHaveBeenCalledTimes(1);
 expect(recoverFailedSmsStaffReviews).toHaveBeenCalledTimes(1); expect(dispatchOpsEvents).toHaveBeenCalledTimes(4);
 expect(setOpsIncident).toHaveBeenCalledWith(expect.objectContaining({ active:true, key:'fleet-health' }));
 await stopOperationsWorker(); await jest.advanceTimersByTimeAsync(6000); expect(dispatchOpsEvents).toHaveBeenCalledTimes(4);
});
test('one failed tick does not permanently stop recovery', async () => {
 readScaleHealth.mockRejectedValueOnce(new Error('database down'));
 startOperationsWorker(); await jest.advanceTimersByTimeAsync(5001); expect(readScaleHealth).toHaveBeenCalledTimes(2);
});
