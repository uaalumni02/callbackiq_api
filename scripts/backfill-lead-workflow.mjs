import 'dotenv/config';
import mongoose from 'mongoose';
import Lead from '../src/models/lead.js';
import '../src/models/alert.js';
import '../src/models/appointment.js';
import '../src/models/callLog.js';
import '../src/models/conversation.js';
import '../src/models/message.js';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { archiveInactiveLead, recomputeLeadWorkflowFlags } from '../src/services/stateTransitions/leadWorkflow.js';
import { queryBudgetMs } from '../src/services/scale/queryBudget.js';

const [, , ...args] = process.argv;
if (args.length && (args.length !== 2 || args[0] !== '--after' || !mongoose.isObjectIdOrHexString(args[1]))) {
  throw new Error('Usage: node scripts/backfill-lead-workflow.mjs [--after LEAD_OBJECT_ID]');
}
let after = args[1];
const mongoUrl = getMongoUrl();
if (!mongoUrl) throw new Error('MONGO_URL is required');

await mongoose.connect(mongoUrl, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
try {
  const batchSize = 100;
  const now = new Date();
  const last = await Lead.findOne().sort({ _id: -1 }).select('_id').maxTimeMS(queryBudgetMs()).lean();
  let processed = 0;
  let archived = 0;
  while (last) {
    const ids = { $lte: last._id, ...(after ? { $gt: after } : {}) };
    const leads = await Lead.find({ _id: ids }).sort({ _id: 1 }).limit(batchSize).maxTimeMS(queryBudgetMs()).lean();
    if (!leads.length) break;
    for (const lead of leads) {
      if (await archiveInactiveLead(lead, now)) archived += 1;
      await recomputeLeadWorkflowFlags(lead.business, lead._id);
      processed += 1;
    }
    after = String(leads.at(-1)._id);
    console.log(JSON.stringify({ processed, archived, resumeAfter: after }));
  }
  console.log(JSON.stringify({ complete: true, processed, archived }));
} finally {
  await mongoose.disconnect();
}
