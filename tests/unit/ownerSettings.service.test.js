import mongoose from "mongoose";
import Business from "../../src/models/business.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import ServiceArea from "../../src/models/serviceArea.js";
import AvailabilityRule from "../../src/models/availabilityRule.js";
import AvailabilityException from "../../src/models/availabilityException.js";
import SchedulingPolicy from "../../src/models/schedulingPolicy.js";
import BusinessOperationsSettings from "../../src/models/businessOperationsSettings.js";
import { readOwnerSettings, saveOwnerSettings } from "../../src/services/ownerSettings.service.js";
import { validateOwnerSection } from "../../src/validator/ownerSettings.js";
import { recordVoiceSettingsVersion } from "../../src/services/voiceSettingsVersion.service.js";
jest.mock("../../src/services/voiceSettingsVersion.service.js", () => ({ recordVoiceSettingsVersion: jest.fn().mockResolvedValue({ version: 1 }) }));
const models = [ServiceOffering, ServiceArea, AvailabilityRule, AvailabilityException, SchedulingPolicy, BusinessOperationsSettings];
let business, owner, rows, session;
const query = value => ({ session: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(Array.isArray(value) ? value.map(v => v.toObject?.() || v) : value), then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
beforeEach(() => {
  owner = new mongoose.Types.ObjectId();
  business = new Business({ owner, businessName: "Plumbing", businessType: "plumbing", phone: "+14045550101", forwardingPhone: "+14045550102", timezone: "America/New_York" });
  rows = new Map(models.map(m => [m, []]));
  session = { withTransaction: jest.fn(fn => fn()), endSession: jest.fn() };
  jest.spyOn(mongoose, "startSession").mockResolvedValue(session);
  jest.spyOn(Business, "findOne").mockImplementation(({ owner: requested }) => query(String(requested) === String(owner) ? business : null));
  jest.spyOn(Business.prototype, "save").mockImplementation(async function () { await this.validate(); return this; });
  for (const Model of models) {
    jest.spyOn(Model, "find").mockImplementation(({ business: id }) => query(rows.get(Model).filter(v => String(v.business) === String(id))));
    jest.spyOn(Model, "findOne").mockImplementation(filter => query(rows.get(Model).find(v => String(v.business) === String(filter.business) && (!filter._id || String(v._id) === String(filter._id))) || null));
    jest.spyOn(Model.prototype, "save").mockImplementation(async function () { await this.validate(); if (!rows.get(Model).includes(this)) rows.get(Model).push(this); return this; });
  }
  jest.spyOn(AvailabilityRule, "findOneAndUpdate").mockImplementation(async (filter, update) => {
    let doc = rows.get(AvailabilityRule).find(v => v.dayOfWeek === filter.dayOfWeek) || new AvailabilityRule(filter);
    doc.set(update.$set); return doc.save({ session });
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
const save = async (section, change) => {
  const snapshot = await readOwnerSettings(business);
  const payload = { ...snapshot.sections[section], ...change };
  return saveOwnerSettings({ ownerId: owner, section, payload, revision: snapshot.revision });
};
test("read output is valid for all five save contracts without exposing infrastructure", async () => {
  const snapshot = await readOwnerSettings(business);
  for (const [section, values] of Object.entries(snapshot.sections)) await expect(validateOwnerSection(section, values)).resolves.toBeTruthy();
  expect(snapshot.sections.hours.schedulingPolicy.aiBookingConfirmationMode).toBe("manual");
  expect(snapshot).not.toHaveProperty("twilioAuthToken");
  expect(snapshot.sections.calls).not.toHaveProperty("maxConcurrentCalls");
});
test("staff approval saves one shared booking choice and preserves unrelated operations", async () => {
  const operations = new BusinessOperationsSettings({ business: business._id, followUpSettings: { maxAttempts: 7 }, serviceEligibilityPolicy: { excludedServices: ["roof repair"] } });
  rows.get(BusinessOperationsSettings).push(operations);
  const result = await save("hours", { bookingMode: "approval" });
  expect(result.sections.hours.bookingMode).toBe("approval");
  expect(business.features.aiBookingEnabled).toBe(true);
  expect(operations.aiPermissions.canBookEligibleServices).toBe(true);
  expect(operations.followUpSettings.maxAttempts).toBe(7);
  expect(operations.serviceEligibilityPolicy.excludedServices).toEqual(["roof repair"]);
  expect(session.withTransaction).toHaveBeenCalledTimes(1);
  expect(recordVoiceSettingsVersion).toHaveBeenCalledWith(expect.objectContaining({ mongoSession: session }));
});
test("saving team contacts does not change booking permission or follow-up policy", async () => {
  const operations = new BusinessOperationsSettings({ business: business._id, aiPermissions: { canBookEligibleServices: true }, followUpSettings: { maxAttempts: 7 } });
  rows.get(BusinessOperationsSettings).push(operations);
  const result = await save("team", { humanHandoffContacts: [{ name: "Dispatch", email: "dispatch@example.com", active: true }] });
  expect(result.sections.team.humanHandoffContacts[0].name).toBe("Dispatch");
  expect(operations.aiPermissions.canBookEligibleServices).toBe(true);
  expect(operations.followUpSettings.maxAttempts).toBe(7);
});
test("enabling voice while disabling texts preserves technical limits", async () => {
  business.voiceSettings.dailyVoiceMinutes = 321;
  const result = await save("calls", { answerMode: "always", automaticTextsEnabled: false, missedCallSmsEnabled: false });
  expect(result.voiceEnabled).toBe(true);
  expect(business.customerMessaging.automaticTextsEnabled).toBe(false);
  expect(business.voiceSettings.dailyVoiceMinutes).toBe(321);
});
test("stale revision and another owner's request cannot modify settings", async () => {
  const before = await readOwnerSettings(business);
  business.businessName = "Changed elsewhere";
  await expect(saveOwnerSettings({ ownerId: owner, section: "business", payload: before.sections.business, revision: before.revision })).rejects.toMatchObject({ statusCode: 409 });
  await expect(saveOwnerSettings({ ownerId: new mongoose.Types.ObjectId(), section: "business", payload: before.sections.business, revision: before.revision })).rejects.toMatchObject({ statusCode: 404 });
  expect(Business.prototype.save).not.toHaveBeenCalled();
});
test("rejects unsupported fields, malformed booleans and duplicate weekdays", async () => {
  await expect(validateOwnerSection("calls", { automaticTextsEnabled: "false" })).rejects.toBeTruthy();
  await expect(validateOwnerSection("business", { phone: "+14045550999" })).rejects.toBeTruthy();
  const before = await readOwnerSettings(business);
  await expect(save("hours", { rules: before.sections.hours.rules.map(r => ({ ...r, dayOfWeek: 1 })) })).rejects.toThrow(/each day/);
});
