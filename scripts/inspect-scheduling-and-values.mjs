import 'dotenv/config';
import mongoose from 'mongoose';
import { businessCalendarProviderName } from '../src/services/scheduling/calendarProviderName.service.js';
const args=process.argv.slice(2), at=args.indexOf('--business');
const businessId=at>=0?args[at+1]:process.env.BUSINESS_ID;
if (!mongoose.isValidObjectId(businessId) || !process.env.MONGO_URL) {
  console.error('Usage: node scripts/inspect-scheduling-and-values.mjs --business BUSINESS_OBJECT_ID (requires MONGO_URL in .env)');
  process.exitCode=1;
} else {
  try {
    await mongoose.connect(process.env.MONGO_URL,{serverSelectionTimeoutMS:10000,autoIndex:false,autoCreate:false});
    const db=mongoose.connection.db, businessKey=new mongoose.Types.ObjectId(businessId);
    const [business,policy,rules,exceptions,connections,services,leads]=await Promise.all([
      db.collection('businesses').findOne({_id:businessKey},{projection:{businessName:1,timezone:1,features:1,featureSettings:1,'integrations.calendar.provider':1}}),
      db.collection('schedulingpolicies').findOne({business:businessKey},{projection:{minimumNoticeMinutes:1,maximumAdvanceDays:1,allowSameDayBooking:1,aiBookingConfirmationMode:1}}),
      db.collection('availabilityrules').find({business:businessKey},{projection:{dayOfWeek:1,enabled:1,windows:1,capacity:1,timezone:1}}).sort({dayOfWeek:1}).toArray(),
      db.collection('availabilityexceptions').find({business:businessKey,active:{$ne:false}},{projection:{date:1,type:1,windows:1,capacity:1}}).sort({date:-1}).limit(30).toArray(),
      db.collection('integrationconnections').find({business:businessKey},{projection:{provider:1,status:1,providerCalendarName:1,providerCalendarId:1,availabilityCalendarIds:1,lastVerifiedAt:1,lastSuccessfulSyncAt:1,lastErrorCode:1}}).toArray(),
      db.collection('serviceofferings').find({business:businessKey,active:true},{projection:{name:1,category:1,keywords:1,excludedKeywords:1,estimatedValue:1,priceEstimateMin:1,priceEstimateMax:1,disclosePriceEstimate:1,aiCanBook:1,aiCanDiscuss:1,durationMinutes:1,minimumNoticeMinutesOverride:1}}).toArray(),
      db.collection('leads').find({business:businessKey},{projection:{phone:1,serviceNeeded:1,estimatedValue:1,valuation:1,preferredAppointmentTime:1,updatedAt:1}}).sort({updatedAt:-1}).limit(20).toArray(),
    ]);
    if (!business) throw new Error('Business not found.');
    const provider=businessCalendarProviderName(business);
    console.log(JSON.stringify({business:{id:businessId,name:business.businessName,timezone:business.timezone,provider,aiBookingEnabled:business.features?.aiBookingEnabled},automatedMinimumNoticeHours:24,policy,rules,exceptions,connections,services,leads:leads.map(({phone,...lead})=>({...lead,phoneLast4:String(phone||'').slice(-4)})),checks:{enabledSchedulingDays:rules.filter(rule=>rule.enabled&&rule.windows?.length).length,activeServices:services.length,googleConnected:connections.some(c=>c.provider==='google_calendar'&&c.status==='connected'),scheduleAuthority:provider==='google_calendar'?'Configured hours and capacity, with selected Google calendars checked for conflicts':provider==='internal'||provider==='jobber'?'CallBackIQ internal scheduling records; outside jobs are not automatically known':'Provider requires configuration/support verification'},readOnly:true},null,2));
  } catch (error) {
    console.error('Diagnostic failed:',error.code||error.name||'ERROR');process.exitCode=1;
  } finally {await mongoose.disconnect();}
}
