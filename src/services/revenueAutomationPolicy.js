/** Pure policies shared by routes, engine, and tests. No provider side effects. */
export const PURPOSE_BY_TYPE=Object.freeze({
  missed_call:'missed_call_recovery',unsold_estimate:'estimate_followup',
  abandoned_booking:'booking_followup',customer_reactivation:'service_reactivation',
  cancellation_capacity:'capacity_offer',unpaid_invoice:'invoice_reminder',
});
export const PURPOSES=Object.freeze(Object.values(PURPOSE_BY_TYPE));
export const VALID_RECORD_STATUSES=Object.freeze({
 estimate:['draft','sent','awaiting_customer','accepted','declined','canceled'],
 job:['draft','scheduled','in_progress','completed','canceled'],
 invoice:['draft','issued','partially_paid','paid','void'],
});
export const RECORD_TRANSITIONS=Object.freeze({
 draft:['sent','scheduled','issued','canceled','void'],
 sent:['awaiting_customer','accepted','declined','canceled'],
 awaiting_customer:['accepted','declined','canceled'],
 accepted:[],declined:[],scheduled:['in_progress','canceled'],in_progress:['completed','canceled'],
 completed:[],issued:['partially_paid','paid','void'],partially_paid:['paid','void'],paid:[],
 canceled:[],void:[],
});
export const TERMINAL_RECOVERY=new Set(['booked','completed','payment_recorded','lost','declined','closed']);
export const STOP_RECORD_STATUSES=Object.freeze({
 estimate:['accepted','declined','canceled'],
 job:['completed','canceled'],
 invoice:['paid','void'],
});
export const BAD_LINK=/^(?:javascript|data|file):/i;
export function httpError(message,statusCode=400){const error=new Error(message);error.statusCode=statusCode;return error;}
export function cents(value){if(typeof value==='string' && !/^\d+(\.\d{1,2})?$/.test(value))throw httpError('Invalid dollar amount');const n=Number(value);if(!Number.isFinite(n)||n<0||n>100000000||Math.abs(Math.round(n*100)-n*100)>1e-7)throw httpError('Invalid dollar amount');return Math.round(n*100);}
export function clean(value,max=200){return typeof value==='string'?value.trim().slice(0,max):'';}
export function validHttpsUrl(value){const v=clean(value,1000);if(!v)return '';let url;try{url=new URL(v)}catch{throw httpError('Payment URL must be valid HTTPS');}if(url.protocol!=='https:'||url.username||url.password||BAD_LINK.test(v)||!url.hostname.includes('.'))throw httpError('Payment URL must be valid HTTPS');return url.toString();}
export function validateRecordTransition(recordType,from,to){if(!VALID_RECORD_STATUSES[recordType]?.includes(to)||!RECORD_TRANSITIONS[from]?.includes(to))throw httpError(`Invalid ${recordType} transition: ${from} -> ${to}`);return to;}
export function permittedPurpose(oppType,purpose){return PURPOSE_BY_TYPE[oppType]===purpose;}
export function localHour(now,timeZone){try {let p=new Intl.DateTimeFormat('en-US',{timeZone:timeZone||'America/New_York',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);return Number(p.find(x=>x.type==='hour').value)}catch{return -1}}
export function inQuietHours(now,timeZone,startHour=20,endHour=9){const h=localHour(now,timeZone);if(h<0)return true;return startHour===endHour?true:startHour>endHour?(h>=startHour||h<endHour):(h>=startHour&&h<endHour);}
export function contactGate({opportunity,campaign,grant,preference,settings,business,record,lead,appointment,now=new Date(),envEnabled=false}){
 if(!envEnabled)return 'global_disabled';
 if(!settings?.enabled||!settings?.liveSendingEnabled)return 'business_disabled';
 if(!business?.isActive)return 'business_inactive';
 if(!opportunity||!permittedPurpose(opportunity.type,campaign.purpose))return 'invalid_opportunity';
 if(TERMINAL_RECOVERY.has(opportunity.status))return 'opportunity_closed';
 if(['missed_call','abandoned_booking','unsold_estimate'].includes(opportunity.type)&&lead&&['booked','lost','spam'].includes(lead.status))return 'underlying_lead_closed';
 if(opportunity.type!=='cancellation_capacity'&&appointment&&['confirmed','completed'].includes(appointment.status))return 'underlying_appointment_booked';
 if(['opted_out'].includes(opportunity.contactPermission)||preference?.smsStatus==='opted_out')return 'customer_opted_out';
 if(record && STOP_RECORD_STATUSES[record.recordType]?.includes(record.status))return 'underlying_record_closed';
 if(record?.customerPhone && record.customerPhone!==campaign.phone)return 'customer_changed';
 if(!grant||grant.status!=='verified'||grant.phone!==campaign.phone||grant.purpose!==campaign.purpose||!grant.evidence)return 'permission_not_verified';
 if(grant.expiresAt && new Date(grant.expiresAt)<=now)return 'permission_expired';
 if(['service_reactivation','capacity_offer'].includes(campaign.purpose)&&grant.basis!=='express_written')return 'marketing_consent_required';
 if(inQuietHours(now,business?.timezone,settings.quietStartHour,settings.quietEndHour))return 'quiet_hours';
 if(campaign.sentCount>=campaign.maxSends)return 'send_limit_reached';
 if(!campaign.approvedAt||!campaign.approvedBy)return 'approval_required';
 if(!/^\+1\d{10}$/.test(campaign.phone))return 'invalid_phone';
 return null;
}
export function renderTemplate(template,{customerName='',title='',amountCents=0,paymentUrl=''}){
 const values={customerName:clean(customerName,100),title:clean(title,160),amount:(Number(amountCents||0)/100).toFixed(2),paymentUrl:validHttpsUrl(paymentUrl)};
 const allowed=['customerName','title','amount','paymentUrl'];
 const unknown=(String(template).match(/{{\s*([^}]+)\s*}}/g)||[]).some(x=>!allowed.includes(x.slice(2,-2).trim()));
 if(unknown)throw httpError('Unsupported template variable');
 return String(template).replace(/{{\s*(\w+)\s*}}/g,(_,key)=>values[key]).trim();
}
