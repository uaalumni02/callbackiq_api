import { recordRecoveryBookingEvent } from '../stateTransitions/recoveryCoordinator.js';
import { persistRecoveryBookingEvidence } from '../stateTransitions/recoveryCoordinator.js';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import RecoveryCase from '../../models/recoveryCase.js';
import RecoveryEvent from '../../models/recoveryEvent.js';
import Appointment from '../../models/appointment.js';
import {safeConsole} from '../../helpers/logging/safeLogger.js';
let running = false;
let nextRun = 0;
// Evidence-only reconciliation. It cannot book, notify, approve, reject, or
// delete work. Runs at most once per minute per process, bounded to 25 cases.
export async function reconcileRecoveryBookingEvidence({now=new Date()}={}) {
  if (process.env.MEEKCALL_RECOVERY_COORDINATOR_ENABLED!=='true' ||
    process.env.MEEKCALL_RECOVERY_BOOKING_RECONCILIATION!=='true' ||
    running || now.getTime()<nextRun) return {skipped:true};
  running = true;
  try {
    const cases = await RecoveryCase.find({status:{$in:['accepted','scheduling']},'booking.status':{$ne:'confirmed'}})
      .sort({updatedAt:1,_id:1}).limit(25).select('_id business lead conversation version').lean();
    let updated=0,failed=0;
    for (const record of cases) {
      try {
        const appointment = await Appointment.findOne({business:record.business,lead:record.lead,
          conversation:record.conversation,status:'confirmed'}).sort({confirmedAt:-1,createdAt:-1})
          .select('_id status startAt').lean();
        if (!appointment) continue;
        const key=`booking-observed:${record._id}:${appointment._id}`;
        const hash=crypto.createHash('sha256').update(key).digest('hex');
        await mongoose.connection.transaction(async session => {
          if (await RecoveryEvent.exists({business:record.business,operationId:key}).session(session)) return;
          const changed=await persistRecoveryBookingEvidence({ RecoveryCase, appointment, now, record, session });
          if (!changed) return;
          await recordRecoveryBookingEvent({ RecoveryEvent, appointment, hash, key, record, session });
          updated++;
        });
      } catch(error) { failed++;safeConsole.error('recovery_coordinator.reconciliation_failed',{caseId:String(record._id),error:error.message}); }
    }
    nextRun=now.getTime()+60000;
    return {scanned:cases.length,updated,failed};
  } finally {running=false;}
}
