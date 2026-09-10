// Read-only historical audit. Never guesses staff acceptance or rewrites metrics.
import 'dotenv/config';
import mongoose from 'mongoose';
import CallLog from '../src/models/callLog.js';
if (!process.env.MONGO_URL) throw new Error('MONGO_URL is required');
try {
  await mongoose.connect(process.env.MONGO_URL);
  const filter = {
    status: 'answered',
    disposition: { $in: ['routing', 'missed', null] },
    answeredAt: null,
    destinationCallSid: { $in: ['', null] },
    notes: 'Missed call forwarded to CallBackIQ Twilio number.',
    providerStatusEvents: { $elemMatch: { providerStatus: 'completed', canonicalStatus: 'answered', applied: true } },
  };
  const count = await CallLog.countDocuments(filter);
  const examples = await CallLog.find(filter).select('_id business providerCallId status disposition').limit(25).lean();
  console.log(JSON.stringify({ count, examples, action: 'Compare these records with provider call-leg evidence before correcting historical outcomes. This audit does not modify data.' },null,2));
} finally { await mongoose.disconnect(); }
