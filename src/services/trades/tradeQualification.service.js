import { patternHasAffirmedSafetyMatch } from '../../helpers/ai/aiGuardrails.js';
import { detectServiceTrades, canonicalTrade, leakContext } from './tradeProfiles.service.js';
const clean = value => String(value || '').replace(/\s+/g,' ').trim();
export const DETAIL_FIELDS = Object.freeze({
 hvac_equipment: { question:'Is this an air conditioner, furnace, heat pump, or another system?', answer:/\b(?:ac|a\/?c|air condition(?:er|ing)|furnace|heat pump|boiler|thermostat|duct)\b/i },
 appliance_type: { question:'Which appliance needs service?', answer:/\b(?:refrigerator|fridge|freezer|dishwasher|washer|washing machine|dryer|oven|stove|cooktop|microwave)\b/i },
 appliance_model: { question:'What is the appliance brand and model, if you know it? You can say unsure.', answer:/\b(?:whirlpool|ge|lg|samsung|bosch|kenmore|maytag|frigidaire|kitchenaid|miele|amana)\b|\b[a-z]{1,6}\d[a-z0-9-]{2,}\b/i, optional:true },
 electrical_scope: { question:'Is the problem limited to one outlet or circuit, several areas, or the whole property?', answer:/\b(?:(?:one|single|only|several|multiple) (?:outlet|circuit|room|area)|(?:whole|entire) (?:house|home|property|building)|throughout (?:the )?(?:house|home|building))\b|^(?:only one|just one|several|multiple|whole property)[.! ]*$/i },
 damage_activity: { question:'Is the damage still spreading or is the source stopped? What caused it, if known?', answer:/\b(?:still|spreading|stopped|dry now|no longer|shut off|turned off|only when|active|not spreading)\b/i },
 door_position: { question:'Is the garage door open, closed, or partly open? Please do not force a damaged door.', answer:/\b(?:stuck (?:open|closed|shut)|(?:is|sitting|left) (?:partly )?(?:open|closed)|halfway|half way|partly open)\b|^(?:open|closed|shut)[.! ]*$/i },
 lockout_target: { question:'Are you locked out of a home, business, or vehicle?', answer:/\b(?:home|house|apartment|condo|business|office|shop|vehicle|car|truck|van)\b/i },
 job_frequency: { question:'Is this a one-time yard service, or are you asking about recurring service?', answer:/\b(?:one[ -]?time|once|single visit|recurring|weekly|monthly|every|ongoing|regular)\b/i },
});
export const DETAIL_FIELD_KEYS = Object.freeze(Object.keys(DETAIL_FIELDS));
const defaults = { hvac:['hvac_equipment'], appliance_repair:['appliance_type'], electrical:['electrical_scope'], restoration:['damage_activity'], garage_door:['door_position'], locksmith:['lockout_target'], landscaping:['job_frequency'] };
function fieldsFor(trade, service, policy) {
 if(Array.isArray(policy.detailFields)) return policy.detailFields.filter(key=>DETAIL_FIELDS[key]);
 if(trade==='locksmith' && !/\b(?:lockout|locked out)\b/i.test(service)) return [];
 if(trade==='restoration' && !/\b(?:water|flood|leak)\b/i.test(service)) return [];
 if(trade==='landscaping' && !/\b(?:lawn|mow|grass|maintenance)\b/i.test(service)) return [];
 if(['electrical','garage_door'].includes(trade) && /\b(?:install|installation|replace|replacement|inspection)\b/i.test(service)) return [];
 return defaults[trade] || [];
}
// A bounded fact ledger. Answers never change permission, diagnose a fault, or
// promise a dispatch. Interrupts and replays cannot consume the answer budget.
export function assessTradeQualification({ service, category='', text='', previous, policy={}, turnId='', factualTurn=false, interrupt=false, correction=false }={}) {
 const key=clean(service).toLowerCase();
 const trade=detectServiceTrades(service)[0] || canonicalTrade(category);
 const state=previous?.serviceKey===key && !correction ? structuredClone(previous) : { version:1, serviceKey:key, trade, answers:{}, attempts:0 };
 const answer=clean(text);
 const hypothetical=/\b(?:what if|suppose|could it|is it|would it)\b/i.test(answer);
 const pendingMatch=state.pending && DETAIL_FIELDS[state.pending]?.answer.test(answer);
 const eligible=!hypothetical && ((!factualTurn && !interrupt && !/\?/.test(answer)) || pendingMatch);
 const detailCorrection=!hypothetical && /\b(?:actually|correction|now|instead|no longer)\b/i.test(answer);
 if(detailCorrection) {
  for(const fieldKey of fieldsFor(trade,service,policy)) {
   if(DETAIL_FIELDS[fieldKey].answer.test(answer)) state.answers[fieldKey]=answer.slice(0,240);
  }
  if(state.requiresStaffReview==='recurring_service_review' && /\b(?:one[ -]?time|single visit|just once)\b/i.test(answer)) {
   delete state.requiresStaffReview; state.answers.job_frequency=answer.slice(0,240);
  }
 }
 if (state.requiresStaffReview) return {...state,status:'needs_staff_review',reason:state.requiresStaffReview};
 const replay=turnId && state.lastTurnId===String(turnId);
 if(state.pending && eligible && !replay) {
  const field=DETAIL_FIELDS[state.pending];
  if(field && (/\b(?:unsure|not sure|don['’]?t know|do not know|no idea)\b/i.test(answer))) {
   if(field.optional) { state.answers[state.pending]='Customer does not know'; delete state.pending; state.attempts=0; }
   else return {...state,status:'needs_staff_review',reason:'trade_detail_unknown',lastTurnId:String(turnId)};
  } else if(field?.answer.test(answer)) {
   state.answers[state.pending]=answer.slice(0,240); delete state.pending; state.attempts=0;
  } else if(state.asked) state.attempts++;
 }
 state.lastTurnId=String(turnId);
 const all=`${service}; ${Object.values(state.answers).join('; ')}; ${eligible ? answer : ''}`;
 const frequency=state.answers.job_frequency || all;
 // Recurring work and hazardous substances need a human decision. A recurring
 // contract must not accidentally become an ordinary single appointment.
 if(/\b(?:recurring|weekly|monthly|every week|every month|ongoing service)\b/i.test(frequency) && !/\b(?:not|no|no longer|don['’]?t want)\s+(?:recurring|weekly|monthly|ongoing)\b/i.test(frequency) && !/\b(?:one[ -]?time (?:estimate|assessment|visit)|initial (?:estimate|assessment|visit))\b/i.test(all))
  return {...state,status:'needs_staff_review',reason:'recurring_service_review',requiresStaffReview:'recurring_service_review'};
 if(/leak substance: (?:unknown|unsure|not sure)/i.test(answer)) return {...state,status:'needs_staff_review',reason:'unknown_leak_substance',requiresStaffReview:'unknown_leak_substance'};
 const substance=leakContext(all);
 if(patternHasAffirmedSafetyMatch(/\bleak(?:ing|s)?\b/i, all) && ['refrigerant','non_water'].includes(substance))
  return {...state,status:'needs_staff_review',reason:'non_water_leak_review',requiresStaffReview:'non_water_leak_review',substance,hazardType:/\b(?:gas|propane)\b/i.test(all) ? 'gas' : ''};
 for(const fieldKey of fieldsFor(trade,service,policy)) {
  if(state.answers[fieldKey]) continue;
  const field=DETAIL_FIELDS[fieldKey];
  if(field.answer.test(service) || (eligible && field.answer.test(answer))) { state.answers[fieldKey]=(field.answer.test(service)?service:answer).slice(0,240); continue; }
  if(state.pending===fieldKey && state.attempts>=2) return {...state,status:'needs_staff_review',reason:'trade_detail_unresolved'};
  return {...state,pending:fieldKey,question:field.question,status:'needs_clarification',reason:'trade_detail_required'};
 }
 delete state.pending;
 return {...state,status:'clear',reason:'trade_details_captured'};
}
export const tradeReviewReply = reason => reason==='recurring_service_review'
 ? 'Recurring service needs team review. I cannot set up or confirm a recurring schedule here. Your request is not a confirmed appointment, and no response time is guaranteed.'
 : reason==='non_water_leak_review'
 ? 'The reported substance leak needs team review before scheduling. Do not attempt a repair. No appointment or response time is guaranteed. If anyone is in immediate danger, call 911; this service does not dispatch emergency help.'
 : 'The team needs to review the remaining job details before scheduling. No appointment or response time is guaranteed.';
