#!/usr/bin/env node
// Summarize exported redacted operational JSONL events. Never emits raw bodies.
import fs from 'node:fs';
const filename=process.argv[2];
if(!filename){console.error('Usage: node scripts/summarizeConversationPolicy.mjs exported-events.jsonl');process.exit(2);}
const lines=fs.readFileSync(filename,'utf8').split(/\r?\n/);
const counts={events:0,invalid:0,byChannel:{},byOutcome:{},byIntent:{},byPhase:{}};
const bump=(map,key)=>{const k=String(key||'unknown').slice(0,64);map[k]=(map[k]||0)+1;};
for(const line of lines){if(!line.trim())continue;let obj;try{obj=JSON.parse(line);}catch{counts.invalid++;continue;}
 const key=obj.event||obj.eventName||obj.name||obj.type||obj.message;
 if(key!=='meekcall.conversation_policy_v3')continue;
 const m=obj.details||obj.metadata||obj.data||obj;
 counts.events++;
 bump(counts.byChannel,m.channel);bump(counts.byOutcome,m.outcome);bump(counts.byIntent,m.intent);bump(counts.byPhase,m.phase);
}
const risk=(counts.byOutcome.loop_risk||0)/Math.max(1,counts.events);
// Warning thresholds are starting operational gates, not measured production SLOs.
console.log(JSON.stringify({version:3,...counts,loopRiskFraction:Number(risk.toFixed(4)),
 flags:{repetitionInvestigationRequired:risk>0.02, missingEvents:counts.events===0}},null,2));
