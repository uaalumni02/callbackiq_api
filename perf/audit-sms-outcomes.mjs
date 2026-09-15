import 'dotenv/config';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import Message from '../src/models/message.js';
import Job from '../src/models/smsProcessingJob.js';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { percentile } from './acceptance.mjs';
// Read only. The caller provides a dedicated staging DB and generated identities.
const manifest = JSON.parse(await fs.readFile(process.env.SCALE_SMS_IDENTITIES_FILE, 'utf8'));
if (!Array.isArray(manifest) || !manifest.length || manifest.some(x => !/^SM[0-9a-f]{32}$/.test(x.sid) || !mongoose.isValidObjectId(x.businessId))) throw new Error('Invalid SMS load identities');
await mongoose.connect(getMongoUrl(), { autoIndex: false, maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
let report;
const deadline = Date.now() + Math.min(300000, Number(process.env.SCALE_OUTCOME_WAIT_MS) || 120000);
try {
  do {
    report = { checked: manifest.length, missing: 0, incomplete: 0, wrongTenant: 0, duplicateReplies: 0, uncertain: 0 };
    const latencies = [];
    for (let start = 0; start < manifest.length; start += 500) {
      const batch = manifest.slice(start, start + 500);
      const messages = await Message.find({ direction: 'inbound', providerMessageId: { $in: batch.map(x => x.sid) } })
        .select('_id providerMessageId business conversation createdAt').maxTimeMS(5000).lean();
      const jobs = await Job.find({ inboundMessage: { $in: messages.map(x => x._id) } }).maxTimeMS(5000).lean();
      const primaryIds = jobs.map(x => x.result?.primaryInboundMessageId).filter(x => mongoose.isValidObjectId(x));
      const replies = await Message.find({ direction: 'outbound', inReplyToMessage: { $in: [...messages.map(x => x._id), ...primaryIds] } })
        .select('business conversation inReplyToMessage providerMessageId providerAcceptedAt status deliveryUncertain').maxTimeMS(5000).lean();
      const primaryJobs = primaryIds.length ? await Job.find({ inboundMessage: { $in: primaryIds } }).maxTimeMS(5000).lean() : [];
      for (const expected of batch) {
        const matches = messages.filter(m => m.providerMessageId === expected.sid);
        if (matches.length !== 1) { report.missing++; continue; }
        const message = matches[0], job = jobs.find(j => String(j.inboundMessage) === String(message._id));
        if (String(message.business) !== expected.businessId || (job && String(job.business) !== expected.businessId)) report.wrongTenant++;
        if (!job || job.status !== 'completed') { report.incomplete++; continue; }
        const parent = job.result?.decision === 'coalesced' ? primaryJobs.find(j => String(j.inboundMessage) === job.result.primaryInboundMessageId) : job;
        if (!parent || parent.status !== 'completed' || String(parent.business) !== expected.businessId) { report.incomplete++; continue; }
        const found = replies.filter(r => String(r.inReplyToMessage) === String(parent.inboundMessage));
        if (found.length > 1) report.duplicateReplies++;
        if (found.length !== 1) { report.incomplete++; continue; }
        const reply = found[0];
        if (String(reply.business) !== expected.businessId || String(reply.conversation) !== String(message.conversation)) report.wrongTenant++;
        if (reply.deliveryUncertain || !reply.providerMessageId || ['failed', 'undelivered', 'suppressed'].includes(reply.status)) { report.uncertain++; continue; }
        if (!reply.providerAcceptedAt) { report.incomplete++; continue; }
        latencies.push(Math.max(0, new Date(reply.providerAcceptedAt) - new Date(message.createdAt)));
      }
    }
    report.providerAcceptanceP95Ms = percentile(latencies, .95);
    if (!(report.missing || report.incomplete) || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
  await fs.writeFile(process.env.SCALE_OUTCOME_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (report.missing || report.incomplete || report.wrongTenant || report.duplicateReplies || report.uncertain) process.exitCode = 1;
} finally { await mongoose.disconnect(); }
