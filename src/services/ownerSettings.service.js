import { applyOwnerCallSettings } from './ownerSettingsVoice.service.js';
import {readStaffDeliveryState} from './notifications/recipientPolicy.service.js';
import { saveStateDocument } from './stateTransitions/documents.js';
import { refreshUpcomingAppointmentNotifications } from './scheduling/appointmentNotification.service.js';
import { getTradeSetup } from './trades/tradeSetup.service.js';
import { validateWindows } from './scheduling/availabilityWindows.service.js';
import crypto from "node:crypto";
import mongoose from "mongoose";
import Business from "../models/business.js";
import ServiceOffering from "../models/serviceOffering.js";
import ServiceArea from "../models/serviceArea.js";
import AvailabilityRule from "../models/availabilityRule.js";
import AvailabilityException from "../models/availabilityException.js";
import SchedulingPolicy from "../models/schedulingPolicy.js";
import BusinessOperationsSettings from "../models/businessOperationsSettings.js";
import {normalizePhoneToE164} from "../voice/voicePhone.service.js";
import { validateOwnerSection } from "../validator/ownerSettings.js";
import { normalizeVoiceSettings } from "../voice/voiceRouting.service.js";
import { recordVoiceSettingsVersion } from "./voiceSettingsVersion.service.js";
const plain = value => value?.toObject?.() || value;
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const profileKeys = ["businessName", "businessType", "forwardingPhone", "email", "website", "address", "city", "state", "zipCode", "timezone"];
const serviceKeys = ["diagnosticFallback", "_id", "name", "category", "description", "active", "aiCanDiscuss", "aiCanBook", "durationMinutes", "bufferBeforeMinutes", "bufferAfterMinutes", "estimatedValue", "priceEstimateMin", "priceEstimateMax", "disclosePriceEstimate", "priceEstimateDisclaimer", "diagnosticFee", "discloseDiagnosticFee", "emergencyEligible", "requiresHumanReview", "keywords", "excludedKeywords", "intakePolicy"];
const ruleKeys = ["dayOfWeek", "enabled", "windows", "timezone", "capacity", "separateAnsweringHours", "answeringEnabled", "answeringWindows"];
const exceptionKeys = ["_id", "date", "type", "name", "allDay", "windows", "capacity", "reason", "active", "appliesTo"];
const policyKeys = ["customerRemindersEnabled", "reminderHours", "postAppointmentFollowUpEnabled", "postAppointmentFollowUpDelayHours", "staffSmsEnabled", "staffSmsPhone", "approvalSmsEnabled", "approvalSmsPhone", "automaticConfirmationAuthorized", "appointmentStyle", "arrivalWindowMinutes", "minimumNoticeMinutes", "maximumAdvanceDays", "slotIntervalMinutes", "defaultDurationMinutes", "requireAddressBeforeBooking", "requireServiceBeforeBooking", "allowSameDayBooking", "allowAfterHoursBooking", "aiBookingConfirmationMode", "manualApprovalHoldMinutes", "customerCancellationAllowed", "cancellationNoticeMinutes", "confirmationMessageTemplate", "cancellationMessageTemplate", "rescheduleMessageTemplate"];
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const cleanWindows = row => ({ ...row, windows: (row.windows || []).map(w => pick(w, ["startTime", "endTime"])) });
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Lean reads do not apply schema defaults to pre-existing records. Fill missing
// fields in the response only, keeping explicit false/zero/empty values intact.
const withDefaults = (defaults, stored) => {
  const result = { ...defaults, ...stored };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (stored?.[key] == null) result[key] = fallback;
    else if (fallback && typeof fallback === "object" && !Array.isArray(fallback) && Object.getPrototypeOf(fallback) === Object.prototype) {
      result[key] = withDefaults(fallback, stored[key]);
    }
  }
  return result;
};

// Delivery-test clocks are operational state; actual settings and consent remain in the optimistic-lock digest.
const revisionOperations = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['notificationTestAt', 'updatedAt'].includes(key))));

// Reads do not create defaults in the database or activate features.
export async function readOwnerSettings(business, session = null) {
  const scoped = Model => Model.find({ business: business._id }).session(session).sort({ _id: 1 }).lean();
  // Sequential queries are intentional: this function is also used inside a transaction.
  const services = await scoped(ServiceOffering);
  const areas = await scoped(ServiceArea);
  const rules = await scoped(AvailabilityRule);
  const exceptions = await scoped(AvailabilityException);
  const policies = await scoped(SchedulingPolicy);
  const operations = await scoped(BusinessOperationsSettings);
  const policy = withDefaults(plain(new SchedulingPolicy({ business: business._id })), policies[0]);
  const ops = withDefaults(plain(new BusinessOperationsSettings({ business: business._id })), operations[0]);
  const area = withDefaults(plain(new ServiceArea({ business: business._id })), areas[0]);
  const voice = normalizeVoiceSettings(business);
  const sections = {
    business: pick(business, profileKeys),
    services: {
      services: services.map(s => pick(s, serviceKeys)), removedServiceIds: [],
      serviceArea: pick(area, ["type", "zipCodes", "centerPostalCode", "radiusMiles"]),
      serviceEligibilityPolicy: plain(ops.serviceEligibilityPolicy),
    },
    hours: {
      rules: Array.from({ length: 7 }, (_, dayOfWeek) => cleanWindows(pick(rules.find(r => r.dayOfWeek === dayOfWeek) || { dayOfWeek, enabled: false, windows: [], timezone: business.timezone || "America/New_York", capacity: 1 }, ruleKeys))),
      exceptions: exceptions.filter(e => e.active).map(e => cleanWindows(pick(e, exceptionKeys))), removedExceptionIds: [],
      schedulingPolicy: pick(policy, policyKeys),
      bookingMode: business.features?.aiBookingEnabled ? policy.aiBookingConfirmationMode === "auto" && policy.automaticConfirmationAuthorized === true ? "automatic" : "approval" : "callback",
    },
    calls: {
      ...pick(voice, ["answerMode", "transferPhone", "overflowRingSeconds", "liveTransferEnabled", "liveTransferPhone"]),
      welcomeGreeting: business.voiceSettings?.welcomeGreeting || "",
      smsTemplate: business.smsTemplate || "",
      missedCallSmsEnabled: business.features?.missedCallSmsEnabled !== false,
      automaticTextsEnabled: business.customerMessaging?.automaticTextsEnabled !== false,
      voiceTextsEnabled: business.customerMessaging?.configured ? business.customerMessaging.voiceTextsEnabled !== false : business.features?.missedCallSmsEnabled !== false,
      appointmentTextsEnabled: business.customerMessaging?.appointmentTextsEnabled !== false,
    },
    team: { humanHandoffContacts: plain(ops.humanHandoffContacts) || [], emergencyPolicy: pick(plain(ops.emergencyPolicy), ["emergencyContactPhone", "emergencyContactEmail"]) },
  };
  // Include stored records in the revision so edits through older screens are detected too.
  const revision = hash({ business: pick(business, [...profileKeys, "smsTemplate", "features", "voiceSettings", "customerMessaging", "ownerSettingsRevision"]), services, areas, rules, exceptions, policies, operations: revisionOperations(operations) });
  const automated = business.features?.voiceAiEnabled || (sections.calls.automaticTextsEnabled && sections.calls.missedCallSmsEnabled);
  const checklist = [
    { section: "business", label: "Add your business details", complete: Boolean(business.businessName && business.forwardingPhone) },
    ...(automated ? [
      { section: "services", label: "Add your services and service area", complete: services.some(s => s.active) && (area.type === "unrestricted" || area.type === "radius" && Boolean(area.centerPostalCode && area.radiusMiles) || area.type === "zip_codes" && area.zipCodes?.length > 0) },
      { section: "hours", label: "Add your business hours", complete: rules.some(r => r.enabled && r.windows?.length) },
      { section: "team", label: "Choose who receives customer requests", complete: Boolean(ops.humanHandoffContacts?.some(c => c.active && (c.phone || c.email)) && ops.emergencyPolicy?.emergencyContactPhone && ops.emergencyPolicy?.emergencyContactEmail) },
    ] : []),
  ];
  const notificationDelivery = session ? [] : await readStaffDeliveryState(business._id);
  return JSON.parse(JSON.stringify({ notificationDelivery, businessId: String(business._id), sections, revision, checklist, tradeSetup: getTradeSetup(business.businessType, services, policy), notificationReadiness: { staffSmsEnabled: process.env.STAFF_NOTIFICATION_SMS_ENABLED !== 'false', smsEnabled: process.env.STAFF_APPROVAL_SMS_ENABLED === 'true', emailEnabled: process.env.STAFF_NOTIFICATION_EMAIL_ENABLED === 'true', warning: process.env.STAFF_NOTIFICATION_EMAIL_ENABLED === 'true' ? 'Notifications use saved active Team & Urgent Requests contacts. Confirm receipt with a test; acceptance does not prove delivery.' : 'Email alerts are not available yet. Contact support to activate them. Check your customer inbox until delivery is verified.' }, trackingPhone: business.phone || "", voiceEnabled: voice.voiceAiEnabled,
    customRouting: voice.routingPolicy,
    bookingRestrictedServices: services.filter(s => s.active && (!s.aiCanBook || s.requiresHumanReview)).map(s => s.name),
  }));
}

async function saveDocument(Model, businessId, values, session) {
  const document = await Model.findOne({ business: businessId }).session(session) || new Model({ business: businessId });
  for (const [key, value] of Object.entries(values)) document.set(key, value);
  await saveStateDocument(document, { session });
  return document;
}

async function saveRows(Model, businessId, rows, removed, session) {
  const ids = rows.filter(r => r._id).map(r => String(r._id));
  if (new Set(ids).size !== ids.length || removed.some(id => ids.includes(id))) throw error("A row cannot be saved and removed at the same time.");
  for (const id of removed) {
    const result = await Model.deleteOne({ business: businessId, _id: id }, { session });
    if (!result.deletedCount) throw error("This item changed. Reload settings before saving.", 409);
  }
  for (const row of rows) {
    const { _id, ...values } = row;
    const document = _id ? await Model.findOne({ business: businessId, _id }).session(session) : new Model({ business: businessId });
    if (!document) throw error("This item does not belong to your business or was removed.", 409);
    document.set(values);
    await saveStateDocument(document, { session });
  }
}

const normalizeTeamDestinations=payload=>{
 const normalize=value=>{if(!value)return '';const result=normalizePhoneToE164(value);if(!/^\+1\d{10}$/.test(result || ''))throw error('Enter a valid US mobile number including its area code.');return result;};
 return {...payload,humanHandoffContacts:(payload.humanHandoffContacts || []).map(contact=>({...contact,phone:normalize(contact.phone)})),emergencyPolicy:{...payload.emergencyPolicy,emergencyContactPhone:normalize(payload.emergencyPolicy?.emergencyContactPhone)}};
};
const saveTeamSettings=async(id,values,ownerId,session)=>{
 for(const contact of values.humanHandoffContacts || [])if(!contact.phone && !contact.email)throw error("Each team contact needs a phone number or email address.");
 const urgent=values.emergencyPolicy || {};
 if(Boolean(urgent.emergencyContactPhone)!==Boolean(urgent.emergencyContactEmail))throw error("Save both a US mobile number (+1…) and an email for your urgent contact.");
 await saveDocument(BusinessOperationsSettings,id,{...values,notificationConsent:{actor:ownerId,at:new Date()}},session);
};

async function saveOwnerHours(business, values, session) {
  const id = business._id;
  if (values.rules.length !== 7 || new Set(values.rules.map(r => r.dayOfWeek)).size !== 7) throw error("Provide each day of the week once.");
  for (const rule of values.rules) {
    if (rule.enabled && !rule.windows.length) throw error("Add opening and closing times for each open day.");
    validateWindows(rule.windows);
    if (rule.separateAnsweringHours) {
      if (rule.answeringEnabled && !rule.answeringWindows?.length) throw error('Add answering hours or mark the office closed.');
      validateWindows(rule.answeringWindows || []);
    }
    await AvailabilityRule.findOneAndUpdate({ business: id, dayOfWeek: rule.dayOfWeek }, { $set: { ...rule, timezone: business.timezone } }, { upsert: true, runValidators: true, session });
  }
  for (const exception of values.exceptions) {
    if (exception.type === 'special_hours' || exception.allDay === false) {
      if (!exception.windows?.length) throw error('Add hours for the temporary change.');
      validateWindows(exception.windows);
    }
  }
  await saveRows(AvailabilityException, id, values.exceptions, values.removedExceptionIds, session);
  if (values.schedulingPolicy.staffSmsEnabled && !/^\+1\d{10}$/.test(values.schedulingPolicy.staffSmsPhone || '')) throw error('Enter a US mobile number including +1 for customer request texts.');
  if (values.schedulingPolicy.approvalSmsEnabled && !/^\+1\d{10}$/.test(values.schedulingPolicy.approvalSmsPhone || '')) throw error('Enter a US mobile number including +1 for approval texts.');
  const booking = values.bookingMode !== "callback";
  await saveDocument(SchedulingPolicy, id, { ...values.schedulingPolicy, automaticConfirmationAuthorized: values.bookingMode === "automatic", aiBookingConfirmationMode: values.bookingMode === "automatic" ? "auto" : "manual" }, session);
  const ops = await BusinessOperationsSettings.findOne({ business: id }).session(session) || new BusinessOperationsSettings({ business: id });
  // Translate a deliberate booking choice, while leaving unrelated business permissions intact.
  ops.set("aiPermissions.canBookEligibleServices", booking);
  ops.set("aiPermissions.canConfirmAvailability", booking);
  if (booking) {
    ops.set("aiPermissions.canCollectAddress", true);
    ops.set("aiPermissions.canCollectAppointmentPreference", true);
    ops.set("aiPermissions.canDiscussServices", true);
  }
  await saveStateDocument(ops, { session });
  business.set("features.aiBookingEnabled", booking);
}

export async function saveOwnerSettings({ ownerId, section, payload, revision }) {
  if(section==='team')payload=normalizeTeamDestinations(payload);
  let values = section === "business" ? null : await validateOwnerSection(section, payload);
  if (!revision || typeof revision !== "string") throw error("Reload settings before saving.", 409);
  const session = await mongoose.startSession();
  try {
    let response;
    let savedBusinessId;
    await session.withTransaction(async () => {
      const business = await Business.findOne({ owner: ownerId }).session(session);
      if (!business) throw error("Business not found.", 404);
      const before = await readOwnerSettings(business, session);
      if (before.revision !== revision) throw error("Settings changed in another window. Your edits are still here. Reload saved settings before trying again.", 409);
      const id = business._id;
      savedBusinessId = id;
      if (section === "business") {
        values = await validateOwnerSection(section, payload, { currentBusinessType: business.businessType });
        try { new Intl.DateTimeFormat("en", { timeZone: values.timezone }); } catch { throw error("Choose a valid time zone."); }
        business.set(values);
        if (values.timezone !== before.sections.business.timezone) await AvailabilityRule.updateMany({ business: id }, { $set: { timezone: values.timezone } }, { session });
      }
      if (section === "services") {
        const area = values.serviceArea;
        if (area.type === "radius" && !area.centerPostalCode) throw error("Enter the ZIP code at the center of your service area.");
        await saveRows(ServiceOffering, id, values.services, values.removedServiceIds, session);
        await saveDocument(ServiceArea, id, area, session);
        const ops = await saveDocument(BusinessOperationsSettings, id, { serviceEligibilityPolicy: values.serviceEligibilityPolicy }, session);
        const newlyDisclosedFee = values.services.some(service => service.discloseDiagnosticFee && !before.sections.services.services.find(old => String(old._id) === String(service._id))?.discloseDiagnosticFee);
        if (newlyDisclosedFee) { ops.set("aiPermissions.canDiscussDiagnosticFees", true); await saveStateDocument(ops, { session }); }
      }
      if (section === "hours") await saveOwnerHours(business, values, session);
      if (section === "team") await saveTeamSettings(id,values,ownerId,session);
      if (section === "calls") applyOwnerCallSettings({ business, values });
      business.ownerSettingsRevision = (business.ownerSettingsRevision || 0) + 1;
      await saveStateDocument(business, { session });
      if (section === "calls" || section === "hours" && before.sections.hours.bookingMode !== values.bookingMode) {
        await recordVoiceSettingsVersion({ business, publishedBy: ownerId, reason: `Owner saved ${section} settings`, source: "owner_settings", mongoSession: session });
      }
      response = await readOwnerSettings(business, session);
    });
    if (section === 'hours') {
      try { await refreshUpcomingAppointmentNotifications({ businessId: savedBusinessId }); }
      catch { response.notificationRefreshWarning = 'Settings saved. Existing reminder schedules could not be refreshed; check upcoming visits.'; }
    }
    return response;
  } finally { await session.endSession(); }
}
