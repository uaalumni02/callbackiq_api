import Appointment from '../../models/appointment.js';
import Business from '../../models/business.js';
import SchedulingProviderFactory from './schedulingProviderFactory.js';
import { repairCompensation } from './reschedule/compensation.js';
export async function repairRescheduleCompensations(limit = 25) {
  const rows = await Appointment.find({ 'providerCompensation.pending': true,
    'providerCompensation.nextAttemptAt': { $lte: new Date() } }).sort({ 'providerCompensation.nextAttemptAt': 1 }).limit(limit).lean();
  for (const row of rows) {
    const business = await Business.findById(row.business);
    if (!business) continue;
    await repairCompensation({ Appointment, appointmentId: row._id,
      provider: SchedulingProviderFactory.getProvider(business, row.providerCompensation.provider || row.provider) });
  }
}
