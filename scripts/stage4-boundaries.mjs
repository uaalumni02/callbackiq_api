#!/usr/bin/env node
// Stage 4 architecture boundary test. May run without GitHub Actions.
import fs from 'node:fs';
const target='src/services/booking/bookingTurnDecision.policy.js';
if (!fs.existsSync(target)) throw new Error(`Missing Stage 4 policy: ${target}`);
const source=fs.readFileSync(target,'utf8');
const forbidden=[
  /\b(?:import|require)\s*(?:\(|['"{*])/,
  /\b(?:fetch|apiFetch|mongoose|MongoClient|process\.env|localStorage|sessionStorage)\b/,
  /\b(?:\.save|\.findOneAndUpdate|\.updateOne|\.create)\s*\(/,
  /\b(?:sendSms|sendMessage|stripe|twilio)\b/i,
  /\b(?:Date\.now|new Date|Math\.random)\s*\(/,
];
const code=source.replace(/\/\/[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
for(const rule of forbidden) if (rule.test(code)) throw new Error(`Stage 4 policy boundary violation: ${rule}`);
for(const name of ['createBookingTurnContext','isBookingTurnBlocked','planRejectedBookingPreference']) {
  if (!source.includes(`export const ${name}`)) throw new Error(`Missing pure decision export: ${name}`);
}
console.log('PASS Stage 4B: booking decision policy has no infrastructure dependencies');
