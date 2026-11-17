import Appointment from '../../models/appointment.js';
import Business from '../../models/business.js';
import { safeConsole } from '../../helpers/logging/safeLogger.js';

// Worker-only fleet scan; customer operations always supply an explicit business.
export async function reconcileAppointmentCancellations(cancel, { limit = 25, now = new Date() } = {}) {
  const rows = await Appointment.find({ status: 'cancel_pending',
    'cancellationIntent.leaseUntil': { $lte: now }, 'cancellationIntent.nextAttemptAt': { $lte: now },
  }).setOptions({ allowCrossTenant: true }).sort({ 'cancellationIntent.nextAttemptAt': 1 }).limit(limit).lean();
  for (const row of rows) {
    try {
      const business = await Business.findById(row.business);
      if (!business) continue;
      await cancel({ business, appointmentId: row._id });
    } catch (error) {
      safeConsole.error('appointment.cancellation_recovery_failed', { appointmentId: String(row._id), code: error.code || error.name });
    }
  }
}
