import { BUSINESS_TYPES } from '../../helpers/businessTypes.js';
import { offeringTrade, TRADE_CLARIFICATION, TRADE_PROFILE_VERSION } from './tradeProfiles.service.js';
import { DETAIL_FIELDS } from './tradeQualification.service.js';
const servicesByTrade = {
 plumbing:['Drain cleaning','Faucet repair','Toilet repair','Water heater repair'],
 hvac:['AC repair','Furnace repair','Heat pump repair','HVAC maintenance'],
 roofing:['Roof repair','Roof inspection','Roof replacement'],
 electrical:['Outlet repair','Breaker repair','Electrical panel inspection'],
 restoration:['Water damage assessment','Mold assessment','Fire damage assessment'],
 garage_door:['Garage door repair','Garage opener repair','Garage spring repair'],
 locksmith:['Home lockout','Business lockout','Door lock rekeying'],
 landscaping:['Lawn mowing','Hedge trimming','Irrigation repair','Landscape assessment'],
 appliance_repair:['Refrigerator repair','Washer repair','Dryer repair','Dishwasher repair','Oven repair'],
 other:['Property service assessment'],
};
const detailLabels={hvac_equipment:'Heating or cooling equipment',appliance_type:'Appliance type',appliance_model:'Appliance brand/model (if known)',electrical_scope:'Area affected by the electrical problem',damage_activity:'Whether damage is still spreading',door_position:'Garage door position',lockout_target:'Home, business, or vehicle lockout',job_frequency:'One-time or recurring yard work'};
const notes={
 plumbing:'Confirm the plumbing work you accept and who handles urgent leaks. Do not promise dispatch from an appointment request.',
 hvac:'Review supported equipment and service limits. Refrigerant concerns need staff assessment; verify how urgent loss of heating or cooling reaches your team.',
 roofing:'Separate inspection visits from repair or replacement projects. Weather, access, and crew requirements need team approval.',
 electrical:'Confirm the electrical work you accept. An appointment request never authorizes hazardous troubleshooting or guarantees emergency attendance.',
 restoration:'Use assessment visits for damage projects. Verify urgent notification delivery and a staffed response process before accepting time-sensitive recovery work.',
 garage_door:'Review door, opener, and spring services separately. Damaged doors and springs need a professional; do not promise immediate attendance.',
 locksmith:'Review residential, commercial, and automotive work separately. Your team must verify access authorization; a saved lockout request is not dispatch.',
 landscaping:'Separate individual visits from recurring contracts and larger projects. Recurring schedules require team review.',
 appliance_repair:'List the appliances and brands you service. Collect model details when useful; parts, warranty, and repair completion need team verification.',
 other:'Define each actual service and the details your team needs. This category does not provide blanket support for unrelated industries.',
};
export function getTradeSetup(businessType, services=[], policy={}) {
 const trade=BUSINESS_TYPES.includes(businessType)?businessType:'other';
 return {version:TRADE_PROFILE_VERSION,trade,note:notes[trade],
  // Suggestions are intentionally inactive. Adding a draft and saving it must
  // not change service acceptance, booking permissions, or existing offerings.
  suggestedServices:servicesByTrade[trade].map(name=>({name,category:trade,active:false,aiCanDiscuss:true,aiCanBook:false,requiresHumanReview:true,durationMinutes:90,bufferAfterMinutes:0,keywords:[],excludedKeywords:[],intakePolicy:{requireClarification:false,clarificationQuestion:TRADE_CLARIFICATION[trade],detailKeywords:[]},disclosePriceEstimate:false,discloseDiagnosticFee:false})),
  detailOptions:Object.entries(DETAIL_FIELDS).map(([key,field])=>({key,label:detailLabels[key],question:field.question})),
  catalogWarnings:services.filter(s=>s.active && (!s.category || ['general','other'].includes(s.category))).map(s=>({serviceId:String(s._id),name:s.name,inferredTrade:offeringTrade(s),message:'Review the service category and customer wording. Existing permissions have not changed.'})),
  schedulingNote:['locksmith','restoration','hvac','garage_door'].includes(trade)
   ? `Review your same-day policy and staffed response process. Current minimum notice: ${policy.minimumNoticeMinutes ?? 1440} minutes. Same-day booking: ${policy.allowSameDayBooking?'allowed by policy':'off'}. A request never guarantees arrival.`
   : 'Use the calendar for visits your team can commit to. Job completion, recurring contracts, parts, weather, and project duration need separate team assessment.',
 };
}
