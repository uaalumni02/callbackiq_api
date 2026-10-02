#!/usr/bin/env node
import fs from 'node:fs';
import { BUSINESS_TYPES } from '../src/helpers/businessTypes.js';
export const checks = ['intake_and_corrections','safety_and_staff_escalation','callback_and_takeover','service_and_area_exclusions','unavailable_time','approval_and_customer_notice','delivery_failure_recovery','staff_final_outcome'];
export function validatePilotEvidence(evidence, now=new Date()) {
 const errors=[];
 if(evidence?.schemaVersion!==1) errors.push('schemaVersion must be 1');
 if(!/^[a-f0-9]{40}$/i.test(evidence?.apiCommit || '') || !/^[a-f0-9]{40}$/i.test(evidence?.frontendCommit || '')) errors.push('Record the exact API and frontend deployment commits');
 for(const trade of BUSINESS_TYPES) for(const channel of ['sms','voice']) {
  const rows=(evidence?.pilots || []).filter(p=>p.trade===trade && p.channel===channel);
  if(rows.length!==1){errors.push(`${trade}/${channel}: exactly one pilot record is required`);continue;}
  const row=rows[0], date=Date.parse(row.observedAt);
  if(!row.businessReference || !row.reviewer || !Number.isFinite(date) || date>now.getTime() || now.getTime()-date>30*86400000) errors.push(`${trade}/${channel}: provide a business reference, reviewer and observation time within the last 30 days`);
  for(const key of checks){const result=row.checks?.[key];if(result?.outcome!=='passed' || typeof result.evidence!=='string' || result.evidence.trim().length<8) errors.push(`${trade}/${channel}/${key}: require a passed observation and an evidence reference`);}
 }
 return errors;
}
if(process.argv[1]?.endsWith('verify-multi-trade-pilot.mjs')) {
 if(process.argv.includes('--template')) {
  console.log(JSON.stringify({schemaVersion:1,apiCommit:'',frontendCommit:'',pilots:BUSINESS_TYPES.flatMap(trade=>['sms','voice'].map(channel=>({trade,channel,businessReference:'',reviewer:'',observedAt:'',checks:Object.fromEntries(checks.map(key=>[key,{outcome:'pending',evidence:''}]))})))},null,2));
 } else {
  try {
   const errors=validatePilotEvidence(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
   if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
   else console.log('Pilot evidence is complete for every trade and channel. This checks recorded evidence completeness, not the authenticity of external delivery or staff actions.');
  }catch(error){console.error(`Unable to validate pilot evidence: ${error.message}. Use --template to create a blank record.`);process.exitCode=1;}
 }
}
