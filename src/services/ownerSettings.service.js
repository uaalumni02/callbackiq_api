import crypto from "node:crypto";
import mongoose from "mongoose";
import Business from "../models/business.js";
import ServiceOffering from "../models/serviceOffering.js";
import ServiceArea from "../models/serviceArea.js";
import AvailabilityRule from "../models/availabilityRule.js";
import AvailabilityException from "../models/availabilityException.js";
import SchedulingPolicy from "../models/schedulingPolicy.js";
import BusinessOperationsSettings from "../models/businessOperationsSettings.js";
import { validateOwnerSection } from "../validator/ownerSettings.js";
import { validateUpdate, assertNoDialLoops } from "../controllers/voiceSettings.js";
import { normalizeVoiceSettings, getPresetRoutingPolicy, inferAnswerMode } from "../voice/voiceRouting.service.js";
import { validateVoiceSettingsDraft } from "./voiceSettingsContract.service.js";
import { recordVoiceSettingsVersion } from "./voiceSettingsVersion.service.js";

const plain = value => value?.toObject?.() || value;
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const profileKeys = ["businessName", "businessType", "forwardingPhone", "email", "website", "address", "city", "state", "zipCode", "timezone"];
const serviceKeys = ["_id", "name", "category", "description", "active", "aiCanDiscuss", "aiCanBook", "durationMinutes", "bufferBeforeMinutes", "bufferAfterMinutes", "estimatedValue", "priceEstimateMin", "priceEstimateMax", "disclosePriceEstimate", "priceEstimateDisclaimer", "diagnosticFee", "discloseDiagnosticFee", "emergencyEligible", "requiresHumanReview", "keywords", "excludedKeywords", "intakePolicy"];
const ruleKeys = ["dayOfWeek", "enabled", "windows", "timezone", "capacity"];
const exceptionKeys = ["_id", "date", "type", "name", "allDay", "windows", "capacity", "reason", "active"];
const policyKeys = ["minimumNoticeMinutes", "maximumAdvanceDays", "slotIntervalMinutes", "defaultDurationMinutes", "requireAddressBeforeBooking", "requireServiceBeforeBooking", "allowSameDayBooking", "allowAfterHoursBooking", "aiBookingConfirmationMode", "manualApprovalHoldMinutes", "customerCancellationAllowed", "cancellationNoticeMinutes", "confirmationMessageTemplate", "cancellationMessageTemplate", "rescheduleMessageTemplate"];
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
      bookingMode: business.features?.aiBookingEnabled ? policy.aiBookingConfirmationMode === "auto" ? "automatic" : "approval" : "callback",
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
    team: { humanHandoffContacts: plain(ops.humanHandoffContacts) || [], emergencyPolicy: plain(ops.emergencyPolicy) },
  };
  // Include stored records in the revision so edits through older screens are detected too.
  const revision = hash({ business: pick(business, [...profileKeys, "smsTemplate", "features", "voiceSettings", "customerMessaging", "ownerSettingsRevision"]), services, areas, rules, exceptions, policies, operations });
  const automated = business.features?.voiceAiEnabled || (sections.calls.automaticTextsEnabled && sections.calls.missedCallSmsEnabled);
  const checklist = [
    { section: "business", label: "Add your business details", complete: Boolean(business.businessName && business.forwardingPhone) },
    ...(automated ? [
      { section: "services", label: "Add your services and service area", complete: services.some(s => s.active) && (area.type === "unrestricted" || area.type === "radius" && Boolean(area.centerPostalCode && area.radiusMiles) || area.type === "zip_codes" && area.zipCodes?.length > 0) },
      { section: "hours", label: "Add your business hours", complete: rules.some(r => r.enabled && r.windows?.length) },
      { section: "team", label: "Choose who receives customer requests", complete: Boolean(ops.humanHandoffContacts?.some(c => c.active && (c.phone || c.email))) },
    ] : []),
  ];
  return JSON.parse(JSON.stringify({ businessId: String(business._id), sections, revision, checklist, trackingPhone: business.phone || "", voiceEnabled: voice.voiceAiEnabled,
    customRouting: voice.routingPolicy,
    bookingRestrictedServices: services.filter(s => s.active && (!s.aiCanBook || s.requiresHumanReview)).map(s => s.name),
  }));
}

async function saveDocument(Model, businessId, values, session) {
  const document = await Model.findOne({ business: businessId }).session(session) || new Model({ business: businessId });
  for (const [key, value] of Object.entries(values)) document.set(key, value);
  await document.save({ session });
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
    await document.save({ session });
  }
}

export async function saveOwnerSettings({ ownerId, section, payload, revision }) {
  const values = await validateOwnerSection(section, payload);
  if (!revision || typeof revision !== "string") throw error("Reload settings before saving.", 409);
  const session = await mongoose.startSession();
  try {
    let response;
    await session.withTransaction(async () => {
      const business = await Business.findOne({ owner: ownerId }).session(session);
      if (!business) throw error("Business not found.", 404);
      const before = await readOwnerSettings(business, session);
      if (before.revision !== revision) throw error("Settings changed in another window. Your edits are still here. Reload saved settings before trying again.", 409);
      const id = business._id;
      if (section === "business") {
        try { new Intl.DateTimeFormat("en", { timeZone: values.timezone }); } catch { throw error("Choose a valid time zone."); }
        business.set(values);
        // Existing per-day timezones follow an explicit business timezone change.
        if (values.timezone !== before.sections.business.timezone) await AvailabilityRule.updateMany({ business: id }, { $set: { timezone: values.timezone } }, { session });
      }
      if (section === "services") {
        const area = values.serviceArea;
        if (area.type === "radius" && !area.centerPostalCode) throw error("Enter the ZIP code at the center of your service area.");
        await saveRows(ServiceOffering, id, values.services, values.removedServiceIds, session);
        await saveDocument(ServiceArea, id, area, session);
        const ops = await saveDocument(BusinessOperationsSettings, id, { serviceEligibilityPolicy: values.serviceEligibilityPolicy }, session);
        const newlyDisclosedFee = values.services.some(service => service.discloseDiagnosticFee && !before.sections.services.services.find(old => String(old._id) === String(service._id))?.discloseDiagnosticFee);
        if (newlyDisclosedFee) { ops.set("aiPermissions.canDiscussDiagnosticFees", true); await ops.save({ session }); }
      }
      if (section === "hours") {
        if (values.rules.length !== 7 || new Set(values.rules.map(r => r.dayOfWeek)).size !== 7) throw error("Provide each day of the week once.");
        for (const rule of values.rules) {
          if (rule.enabled && !rule.windows.length) throw error("Add opening and closing times for each open day.");
          const windows = [...rule.windows].sort((a, b) => a.startTime.localeCompare(b.startTime));
          if (windows.some((w, i) => w.startTime >= w.endTime || i > 0 && windows[i - 1].endTime > w.startTime)) throw error("Business hours must end after they start and cannot overlap.");
          await AvailabilityRule.findOneAndUpdate({ business: id, dayOfWeek: rule.dayOfWeek }, { $set: { ...rule, timezone: business.timezone } }, { upsert: true, runValidators: true, session });
        }
        await saveRows(AvailabilityException, id, values.exceptions, values.removedExceptionIds, session);
        const booking = values.bookingMode !== "callback";
        await saveDocument(SchedulingPolicy, id, { ...values.schedulingPolicy, aiBookingConfirmationMode: values.bookingMode === "automatic" ? "auto" : "manual" }, session);
        const ops = await BusinessOperationsSettings.findOne({ business: id }).session(session) || new BusinessOperationsSettings({ business: id });
        // Translate a deliberate booking choice, while leaving unrelated business permissions intact.
        ops.set("aiPermissions.canBookEligibleServices", booking);
        ops.set("aiPermissions.canConfirmAvailability", booking);
        if (booking) {
          ops.set("aiPermissions.canCollectAddress", true);
          ops.set("aiPermissions.canCollectAppointmentPreference", true);
          ops.set("aiPermissions.canDiscussServices", true);
        }
        await ops.save({ session });
        business.set("features.aiBookingEnabled", booking);
      }
      if (section === "team") {
        for (const contact of values.humanHandoffContacts || []) if (!contact.phone && !contact.email) throw error("Each team contact needs a phone number or email address.");
        await saveDocument(BusinessOperationsSettings, id, values, session);
      }
      if (section === "calls") {
        const current = normalizeVoiceSettings(business);
        const voiceInput = pick(values, ["answerMode", "transferPhone", "welcomeGreeting", "overflowRingSeconds", "liveTransferEnabled", "liveTransferPhone"]);
        const update = validateUpdate(voiceInput, current);
        const voiceEnabled = values.answerMode === "custom" ? current.voiceAiEnabled : values.answerMode !== "disabled";
        const routingPolicy = values.answerMode === "custom" ? current.routingPolicy : getPresetRoutingPolicy(values.answerMode);
        const merged = { ...plain(business.voiceSettings), ...update, routingPolicy, routingPolicyVersion: 1, recordingEnabled: false };
        merged.answerMode = inferAnswerMode({ voiceAiEnabled: voiceEnabled, routingPolicy });
        assertNoDialLoops({ business, settings: merged });
        if (merged.liveTransferEnabled && !merged.liveTransferPhone) throw error("Add a separate answered phone number for live transfers.");
        const validation = validateVoiceSettingsDraft({ ...current, ...merged, voiceAiEnabled: voiceEnabled }, { currentVoiceName: current.voiceName });
        if (!validation.valid) throw error(validation.errors.map(e => e.message).join(" "));
        business.set("voiceSettings", merged);
        business.set("features.voiceAiEnabled", voiceEnabled);
        business.set("features.missedCallSmsEnabled", values.missedCallSmsEnabled);
        business.set("customerMessaging", { ...pick(values, ["automaticTextsEnabled", "voiceTextsEnabled", "appointmentTextsEnabled"]), configured: true });
        business.set("smsTemplate", values.smsTemplate);
      }
      business.ownerSettingsRevision = (business.ownerSettingsRevision || 0) + 1;
      await business.save({ session });
      if (section === "calls" || section === "hours" && before.sections.hours.bookingMode !== values.bookingMode) {
        await recordVoiceSettingsVersion({ business, publishedBy: ownerId, reason: `Owner saved ${section} settings`, source: "owner_settings", mongoSession: session });
      }
      response = await readOwnerSettings(business, session);
    });
    return response;
  } finally { await session.endSession(); }
}
