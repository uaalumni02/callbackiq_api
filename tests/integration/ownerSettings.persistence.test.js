import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Business from "../../src/models/business.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import AvailabilityRule from "../../src/models/availabilityRule.js";
import SchedulingPolicy from "../../src/models/schedulingPolicy.js";
import BusinessOperationsSettings from "../../src/models/businessOperationsSettings.js";
import { readOwnerSettings, saveOwnerSettings } from "../../src/services/ownerSettings.service.js";
let replica;
let business;
let owner;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.14" } });
  await mongoose.connect(replica.getUri());
  await Business.init(); await ServiceOffering.init(); await AvailabilityRule.init();
}, 120000);
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  owner = new mongoose.Types.ObjectId();
  business = await Business.create({ owner, businessName: "Atlanta Pro Plumbing", businessType: "plumbing", phone: "+14045550101", forwardingPhone: "+14045550102", email: "owner@example.com", timezone: "America/New_York" });
});
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); });
const get = async () => readOwnerSettings(await Business.findById(business._id));
const save = (section, snapshot, values = snapshot.sections[section]) => saveOwnerSettings({ ownerId: owner, section, payload: values, revision: snapshot.revision });
test("reads have no configuration side effects and default to staff-controlled appointments", async () => {
  const snapshot = await get();
  expect(snapshot.sections.hours.bookingMode).toBe("callback");
  expect(snapshot.sections.hours.schedulingPolicy.aiBookingConfirmationMode).toBe("manual");
  expect(snapshot.sections.hours.rules.every(r => !r.enabled)).toBe(true);
  expect(await SchedulingPolicy.countDocuments()).toBe(0);
  expect(await AvailabilityRule.countDocuments()).toBe(0);
});
test("one save adds services and area, while preserving hidden service policy", async () => {
  const service = await ServiceOffering.create({ business: business._id, name: "Water heater", minimumNoticeMinutesOverride: 2880, keywords: ["water heater"] });
  const snapshot = await get();
  const values = snapshot.sections.services;
  values.services[0].name = "Water heater repair";
  values.services.push({ name: "Drain cleaning", durationMinutes: 90, aiCanBook: true });
  values.serviceArea = { type: "zip_codes", zipCodes: ["30303"] };
  const result = await save("services", snapshot, values);
  expect(result.sections.services.services).toHaveLength(2);
  expect((await ServiceOffering.findById(service._id)).minimumNoticeMinutesOverride).toBe(2880);
});
test("invalid service prevents partial changes to other services or area", async () => {
  await ServiceOffering.create({ business: business._id, name: "Drain cleaning" });
  const snapshot = await get(); const values = snapshot.sections.services;
  values.services[0].name = "Changed name";
  values.services.push({ name: "Broken price", priceEstimateMin: 200, priceEstimateMax: 100 });
  await expect(save("services", snapshot, values)).rejects.toThrow();
  expect((await ServiceOffering.findOne({ business: business._id })).name).toBe("Drain cleaning");
});
test("foreign service IDs cannot be edited and rollback the entire save", async () => {
  const foreign = await ServiceOffering.create({ business: new mongoose.Types.ObjectId(), name: "Other business" });
  const snapshot = await get(); const values = snapshot.sections.services;
  values.services.push({ _id: String(foreign._id), name: "Hijack" });
  await expect(save("services", snapshot, values)).rejects.toMatchObject({ statusCode: 409 });
  expect((await ServiceOffering.findById(foreign._id)).name).toBe("Other business");
});
test("a stale tab cannot overwrite a newer save", async () => {
  const snapshot = await get();
  await save("business", snapshot, { ...snapshot.sections.business, businessName: "First save" });
  await expect(save("business", snapshot, { ...snapshot.sections.business, businessName: "Stale save" })).rejects.toMatchObject({ statusCode: 409 });
});
test("hours and one approval choice update the shared booking permissions atomically", async () => {
  const snapshot = await get(); const values = snapshot.sections.hours;
  values.bookingMode = "approval";
  values.rules[1] = { ...values.rules[1], enabled: true, windows: [{ startTime: "08:00", endTime: "17:00" }] };
  const result = await save("hours", snapshot, values);
  expect(result.sections.hours.bookingMode).toBe("approval");
  expect((await Business.findById(business._id)).features.aiBookingEnabled).toBe(true);
  expect((await BusinessOperationsSettings.findOne({ business: business._id })).aiPermissions.canBookEligibleServices).toBe(true);
  expect((await SchedulingPolicy.findOne({ business: business._id })).aiBookingConfirmationMode).toBe("manual");
});
test("voice can be enabled with all automatic customer texts off", async () => {
  const snapshot = await get();
  const result = await save("calls", snapshot, { ...snapshot.sections.calls, answerMode: "always", automaticTextsEnabled: false, missedCallSmsEnabled: false });
  expect(result.voiceEnabled).toBe(true);
  expect(result.sections.calls.automaticTextsEnabled).toBe(false);
});
test("a phone routing loop is rejected without enabling voice", async () => {
  const snapshot = await get();
  await expect(save("calls", snapshot, { ...snapshot.sections.calls, answerMode: "overflow", transferPhone: business.phone })).rejects.toThrow(/same CallBackIQ/);
  expect((await Business.findById(business._id)).features.voiceAiEnabled).toBe(false);
});
