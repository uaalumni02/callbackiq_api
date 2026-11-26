import {pollStaffSms} from '../notifications/staffSmsPolling.service.js';
/** Returns bounded approval polling with saved-recipient policy; polling failures remain rejected promises. */
export function runApprovalSms(options = {}) {
  return pollStaffSms({ ...options, approval: true });
}
