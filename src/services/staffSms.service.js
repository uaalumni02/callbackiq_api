import {pollStaffSms} from './notifications/staffSmsPolling.service.js';
/** Returns bounded general staff polling with a fenced cursor; polling failures remain rejected promises. */
export function runStaffSms(options = {}) {
  return pollStaffSms({ ...options, approval: false });
}
