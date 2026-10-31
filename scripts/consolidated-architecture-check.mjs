#!/usr/bin/env node
// Architecture boundary guard; zero production side effects.
import fs from 'node:fs';
const files = ["src/services/booking/bookingClassification.policy.js","src/services/booking/bookingTurnDecision.policy.js","src/services/booking/bookingConversation.repository.js","src/db/repositories/userIdentityRepository.js"];
for(const f of files){
 if(!fs.existsSync(f)) throw Error('Missing extracted module '+f);
 const s=fs.readFileSync(f,'utf8');
 if(!s.trim()) throw Error('Empty module '+f);
 if(f.endsWith('.policy.js') && /\b(?:mongoose|fetch|sendSms|stripe|twilio|process\.env|Date\.now)\b/i.test(s.replace(/\/\/[^\n]*/g,''))) throw Error('Impure policy '+f);
 if(f.includes('/features/') && /from\s+['"][^'"]*\/pages\//.test(s)) throw Error('Feature imports page '+f);
}
console.log('PASS: extracted-module boundaries');
