import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { readScaleHealth } from '../src/services/scaleHealth.service.js';
import { emailConfiguration } from '../src/helpers/email/emailConfiguration.js';
// Read-only. Never sends a message or changes production records.
await mongoose.connect(getMongoUrl(), {autoIndex:false,serverSelectionTimeoutMS:10000,maxPoolSize:2});
try {
 const health=await readScaleHealth();
 const result={...health,emailConfigured:emailConfiguration().configured,emailEnabled:process.env.STAFF_NOTIFICATION_EMAIL_ENABLED==='true',ownerTextChannelEnabled:process.env.STAFF_NOTIFICATION_SMS_ENABLED!=='false',scope:process.env.SCALE_PROFILE?'fleet':'automation progress and queue age'};
 console.log(JSON.stringify(result,null,2));
 if(!health.healthy)process.exitCode=1;
} finally {await mongoose.disconnect();}
