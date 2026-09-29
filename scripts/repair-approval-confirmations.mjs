import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';
// Re-arm recovery only; the normal maintenance worker owns enqueueing and send policy.
const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Dry-run: node scripts/repair-approval-confirmations.mjs [--apply]. Uses MONGO_URL. Re-arms confirmed approvals with no confirmation outbox job, including legacy reconciled records.');
} else {
  await mongoose.connect(getMongoUrl(), { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db; let candidates = 0, modified = 0;
    const cursor = db.collection('appointments').find({status:'confirmed',
      $or:[{requiresBusinessApproval:true},{automaticConfirmationAuthorized:true,source:{$ne:'sms'}}]},
      {projection:{_id:1,business:1,updatedAt:1}}).batchSize(100);
    for await (const appointment of cursor) {
      const job = await db.collection('appointmentnotificationjobs').findOne({business:appointment.business,
        appointment:appointment._id,key:'change_notice:business_approval_confirmed'},{projection:{_id:1}});
      if (job) continue;
      candidates++;
      if (args.has('--apply')) modified += (await db.collection('appointments').updateOne({
        _id:appointment._id,business:appointment.business,status:'confirmed',updatedAt:appointment.updatedAt,
      },{$set:{'approvalRecovery.reconciled':false}})).modifiedCount;
    }
    console.log(JSON.stringify({dryRun:!args.has('--apply'),candidates,modified}));
  } finally {await mongoose.disconnect();}
}
