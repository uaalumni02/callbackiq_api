import mongoose from 'mongoose';
import { claimNextInboundSmsJob } from '../../src/services/messaging/smsProcessingQueue.service.js';
const uri = process.env.SCALE_CRASH_TEST_MONGO || '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(uri) || process.env.NODE_ENV !== 'test') throw new Error('Ephemeral local Mongo test only');
await mongoose.connect(uri, { autoIndex: false });
const job = await claimNextInboundSmsJob();
process.send({ claimed: String(job?._id) });
setInterval(() => {}, 1000);
