import { runStaffSms } from '../../src/services/staffSms.service.js';
jest.mock('../../src/services/staffSms.service.js', () => ({runStaffSms:jest.fn().mockResolvedValue({sent:0})}));
import { startStaffNotificationWorker, stopStaffNotificationWorker } from '../../src/workers/staffNotification.worker.js';
import { runStaffNotificationsOnce } from '../../src/services/staffNotification.service.js';
import { logOperationalError } from '../../src/helpers/logging/safeLogger.js';
jest.mock('../../src/services/staffNotification.service.js', () => ({runStaffNotificationsOnce:jest.fn()}));
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({logOperationalError:jest.fn()}));
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
beforeEach(()=>{jest.useFakeTimers();jest.clearAllMocks();process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';runStaffNotificationsOnce.mockResolvedValue({processed:0});});
afterEach(async()=>{await stopStaffNotificationWorker();jest.useRealTimers();delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;delete process.env.STAFF_NOTIFICATION_SMS_ENABLED;});
test('disabled worker does no work',async()=>{process.env.STAFF_NOTIFICATION_SMS_ENABLED='false';delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;startStaffNotificationWorker();await flush();expect(runStaffNotificationsOnce).not.toHaveBeenCalled();});
test('starts once, uses three lanes, logs rejection and schedules the next tick',async()=>{
 const failure=new Error('database unavailable');runStaffNotificationsOnce.mockRejectedValueOnce(failure);
 startStaffNotificationWorker();startStaffNotificationWorker();expect(runStaffNotificationsOnce).toHaveBeenCalledTimes(3);
 await flush();expect(logOperationalError).toHaveBeenCalledWith('staff_notification.worker_failed',failure);
 jest.advanceTimersByTime(5000);expect(runStaffNotificationsOnce).toHaveBeenCalledTimes(6);await flush();
 await stopStaffNotificationWorker();jest.advanceTimersByTime(20000);expect(runStaffNotificationsOnce).toHaveBeenCalledTimes(6);
});
test('stop waits for in-flight claims without scheduling more work',async()=>{
 let release;runStaffNotificationsOnce.mockImplementation(()=>new Promise(r=>{release=r;}));
 // Share one unresolved operation so all three lanes can be released together.
 const pending=new Promise(r=>{release=r;});runStaffNotificationsOnce.mockReturnValue(pending);
 startStaffNotificationWorker();let stopped=false;const stop=stopStaffNotificationWorker().then(()=>{stopped=true;});
 await flush();expect(stopped).toBe(false);release();await stop;expect(stopped).toBe(true);
 jest.advanceTimersByTime(10000);expect(runStaffNotificationsOnce).toHaveBeenCalledTimes(3);
});

test('SMS-only dispatch runs without email enabled', async()=>{
 delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;
 startStaffNotificationWorker(); await flush();
 expect(runStaffSms).toHaveBeenCalledTimes(1);
});
