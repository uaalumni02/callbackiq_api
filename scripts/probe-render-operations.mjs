#!/usr/bin/env node
// Run from a trusted private operator environment with MONGO_URL or MONGODB_URI.
// Checks durable worker heartbeats and processing queues; no customer data printed.
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { readScaleHealth } from '../src/services/scaleHealth.service.js';
const url=getMongoUrl();
if(!url){console.error('Missing MONGO_URL/MONGODB_URI');process.exitCode=2}
else {
 try {
  await mongoose.connect(url,{autoIndex:false,serverSelectionTimeoutMS:7000,maxPoolSize:3});
  const health=await readScaleHealth();
  console.log(JSON.stringify({timestamp:health.timestamp,healthy:health.healthy,roles:health.roles,missingRoles:health.missingRoles,automationWorkerReady:health.automationWorkerReady,smsOldestAgeMs:health.smsOldestAgeMs,recoveryOldestAgeMs:health.recoveryOldestAgeMs,appointmentNoticeOldestAgeMs:health.appointmentNoticeOldestAgeMs,unresolvedAppointmentNotices:health.unresolvedAppointmentNotices,failedPages:health.failedPages,uncertainEmail:health.uncertainEmail},null,2));
  if(!health.healthy)process.exitCode=1;
 }catch(e){console.error('Operational health probe failed:',e.code||e.name||'UNKNOWN');process.exitCode=2}
 finally{await mongoose.disconnect()}
}
