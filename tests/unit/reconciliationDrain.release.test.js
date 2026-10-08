import { reconcileOrphanedInboundSmsJobs } from '../../src/services/messaging/smsProcessingQueue.service.js';
import { claimNextSmsDeliveryReconciliationEvent, completeSmsDeliveryReconciliationEvent } from '../../src/services/messaging/smsDeliveryReconciliation.service.js';
import { processTwilioMessageStatus } from '../../src/services/messaging/smsDeliveryStatus.service.js';
import { startSmsIngressReconciliationWorker, stopSmsIngressReconciliationWorker } from '../../src/workers/smsIngressReconciliation.worker.js';
import { startSmsDeliveryReconciliationWorker, stopSmsDeliveryReconciliationWorker } from '../../src/workers/smsDeliveryReconciliation.worker.js';
jest.mock('../../src/services/messaging/smsProcessingQueue.service.js', () => ({ reconcileOrphanedInboundSmsJobs: jest.fn() }));
jest.mock('../../src/services/messaging/smsDeliveryReconciliation.service.js', () => ({ claimNextSmsDeliveryReconciliationEvent: jest.fn(), completeSmsDeliveryReconciliationEvent: jest.fn(), failSmsDeliveryReconciliationEvent: jest.fn() }));
jest.mock('../../src/services/messaging/smsDeliveryStatus.service.js', () => ({ processTwilioMessageStatus: jest.fn() }));
const flush = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => jest.clearAllMocks());
afterEach(async () => { await stopSmsIngressReconciliationWorker(); await stopSmsDeliveryReconciliationWorker(); });

test('ingress shutdown waits for persistence and does not restart the timer', async () => {
  let release;
  reconcileOrphanedInboundSmsJobs.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const boot = startSmsIngressReconciliationWorker(); await flush();
  let drained = false;
  const stop = stopSmsIngressReconciliationWorker().then(() => { drained = true; });
  await flush(); expect(drained).toBe(false);
  release({ repaired: 0 }); await Promise.all([boot, stop]); expect(drained).toBe(true);
});
test('delivery shutdown finishes its claimed event and makes no further claims', async () => {
  let release;
  claimNextSmsDeliveryReconciliationEvent.mockResolvedValue({ _id: 'event', leaseToken: 'owner', business: 'business', payload: {} });
  processTwilioMessageStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  completeSmsDeliveryReconciliationEvent.mockResolvedValue({});
  const boot = startSmsDeliveryReconciliationWorker(); await flush();
  let drained = false;
  const stop = stopSmsDeliveryReconciliationWorker().then(() => { drained = true; });
  await flush(); expect(drained).toBe(false);
  release({ message: { _id: 'message' } }); await Promise.all([boot, stop]);
  expect(completeSmsDeliveryReconciliationEvent).toHaveBeenCalledTimes(1);
  expect(claimNextSmsDeliveryReconciliationEvent).toHaveBeenCalledTimes(1);
});
