import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Conversation from "../../src/models/conversation.js";
import { applyBookingEvent } from "../../src/services/booking/bookingTurnState.repository.js";
import { applyAppointmentBookingTransition } from "../../src/services/booking/appointmentBookingTransition.repository.js";
import {
  getDistributedLeaseWriteDeadline,
  withDistributedLease,
} from "../../src/services/distributedLease.service.js";

let replicaSet;
const businessId = new mongoose.Types.ObjectId();
const leadId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replicaSet.getUri());
  await Conversation.init();
}, 60000);

afterEach(async () => {
  if (mongoose.connection.readyState === 1) await Conversation.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
}, 60000);

async function createOfferedConversation(bookingState = {}) {
  const startAt = new Date(Date.now() + 86400000);
  const endAt = new Date(startAt.getTime() + 3600000);
  return Conversation.create({
    business: businessId,
    lead: leadId,
    customerPhone: "+14045559876",
    bookingState: { status: "awaiting_confirmation", selectedSlot: { startAt, endAt }, offeredSlots: [{ startAt, endAt }],
      expiresAt: new Date(Date.now() + 60000), ...bookingState },
  });
}

test("concurrent confirmations for one lead yield one provider intent", async () => {
  const conversation = await createOfferedConversation();
  const competing = await Conversation.findById(conversation._id);
  const submit = jest.fn();

  async function confirm(snapshot) {
    const intent = await applyBookingEvent(snapshot, "claim_confirmation", { businessId });
    await submit(intent);
  }

  const outcomes = await Promise.allSettled([confirm(conversation), confirm(competing)]);

  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(({ status }) => status === "rejected").reason).toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ type: "submit_appointment" }));
  expect((await Conversation.findById(conversation._id)).bookingState.status).toBe("booking");
});

test("a lease expiring during the state save cannot persist a claim", async () => {
  const conversation = await createOfferedConversation();
  const originalSave = conversation.save.bind(conversation);
  const save = jest.spyOn(conversation, "save").mockImplementation(async () => {
    const expiresAt = getDistributedLeaseWriteDeadline();
    await delay(Math.max(0, expiresAt.getTime() - Date.now()) + 25);
    return originalSave();
  });

  await expect(withDistributedLease("sms-conversation:" + conversation._id, () =>
    applyBookingEvent(conversation, "claim_confirmation", { businessId }),
    { ttlMs: 2000, heartbeat: false },
  )).rejects.toMatchObject({ code: "DISTRIBUTED_LEASE_LOST" });

  expect(save).toHaveBeenCalledTimes(1);
  const persisted = await Conversation.findById(conversation._id);
  expect(persisted.bookingState.status).toBe("awaiting_confirmation");
  expect(persisted.bookingState.selectedSlot).not.toBeNull();
});

test("decline clears the selected slot and fences stale confirmations", async () => {
  const conversation = await createOfferedConversation();
  const competing = await Conversation.findById(conversation._id);

  await expect(applyBookingEvent(conversation, "decline_confirmation", { businessId })).resolves.toBeNull();
  await expect(applyBookingEvent(competing, "claim_confirmation", { businessId }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  await expect(applyBookingEvent(conversation, "claim_confirmation", { businessId }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  await expect(applyBookingEvent(conversation, "invalid", { businessId })).rejects.toThrow(TypeError);
  expect((await Conversation.findById(conversation._id)).bookingState.toObject()).toMatchObject({
    status: "collecting_preference", offeredSlots: [], selectedSlot: null, expiresAt: null,
  });
});

test("a stale or cross-tenant confirmation cannot claim an offer", async () => {
  const conversation = await createOfferedConversation();
  await expect(applyBookingEvent(conversation, "claim_confirmation", { businessId: new mongoose.Types.ObjectId() }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  const stale = await Conversation.findById(conversation._id);
  await Conversation.updateOne({ _id: conversation._id }, { $set: { humanTakeover: true } });
  await expect(applyBookingEvent(stale, "claim_confirmation", { businessId }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  expect((await Conversation.findById(conversation._id)).bookingState.status).toBe("awaiting_confirmation");
});

test("selecting a current offer persists the selection and rejects a replaced offer", async () => {
  const conversation = await createOfferedConversation({ status: "offering_slots", selectedSlot: null });
  const stale = await Conversation.findById(conversation._id);
  const selectedSlot = stale.bookingState.offeredSlots[0];
  const expiresAt = new Date(Date.now() + 120000);
  const replacement = {
    startAt: new Date(selectedSlot.startAt.getTime() + 86400000),
    endAt: new Date(selectedSlot.endAt.getTime() + 86400000),
  };
  await Conversation.updateOne({ _id: conversation._id }, {
    $set: { "bookingState.offeredSlots": [replacement] },
  });

  await expect(applyBookingEvent(stale, "select_offer", { businessId, selectedSlot, expiresAt }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  const current = await Conversation.findById(conversation._id);
  await expect(applyBookingEvent(current, "select_offer", { businessId, selectedSlot: replacement, expiresAt }))
    .resolves.toBeNull();

  expect((await Conversation.findById(conversation._id)).bookingState.toObject()).toMatchObject({
    status: "awaiting_confirmation", selectedSlot: replacement, expiresAt,
  });
});

test("a new search invalidates selection from a concurrent read of the previous offer", async () => {
  const conversation = await createOfferedConversation({ status: "offering_slots", selectedSlot: null });
  const competing = await Conversation.findById(conversation._id);

  await expect(applyBookingEvent(conversation, "request_new_offer", { businessId })).resolves.toBeNull();
  await expect(applyBookingEvent(competing, "select_offer", {
    businessId, selectedSlot: competing.bookingState.offeredSlots[0], expiresAt: new Date(Date.now() + 120000),
  })).rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
  expect((await Conversation.findById(conversation._id)).bookingState.status).toBe("collecting_preference");
});

test("an expired offer or an offer refreshed for the same slot cannot be confirmed from a stale read", async () => {
  const expired = await createOfferedConversation({ expiresAt: new Date(Date.now() - 1000) });
  await expect(applyBookingEvent(expired, "claim_confirmation", { businessId }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });

  const conversation = await Conversation.findById(expired._id);
  await Conversation.updateOne({ _id: expired._id }, {
    $set: { "bookingState.expiresAt": new Date(Date.now() + 60000) },
  });
  await expect(applyBookingEvent(conversation, "claim_confirmation", { businessId }))
    .rejects.toMatchObject({ code: "BOOKING_STATE_CONFLICT" });
});

test('an appointment projection requires durable confirmation and the expected tenant and link', async () => {
  const newer = new mongoose.Types.ObjectId();
  const old = new mongoose.Types.ObjectId();
  const conversation = await createOfferedConversation({ status: "booked", appointment: newer });
  const appointment = { _id: old, business: businessId, conversation: conversation._id, status: "confirmed" };

  expect((await applyAppointmentBookingTransition(Conversation, "appointment_confirmed", appointment)).matchedCount).toBe(0);
  expect((await applyAppointmentBookingTransition(Conversation, "appointment_canceled", { ...appointment, status: "canceled" })).matchedCount).toBe(0);
  expect((await applyAppointmentBookingTransition(Conversation, "appointment_rescheduled", { ...appointment, rescheduledFrom: old })).matchedCount).toBe(0);
  expect(await applyAppointmentBookingTransition(Conversation, "appointment_confirmed", { ...appointment, _id: newer, status: "held" })).toBeNull();
  expect((await applyAppointmentBookingTransition(Conversation, "appointment_confirmed", {
    ...appointment, _id: newer, business: new mongoose.Types.ObjectId(),
  })).matchedCount).toBe(0);

  const current = { ...appointment, _id: newer };
  await applyAppointmentBookingTransition(Conversation, "appointment_confirmed", current);
  await applyAppointmentBookingTransition(Conversation, "appointment_confirmed", current);
  expect((await applyAppointmentBookingTransition(Conversation, "approval_hold_expired", { ...current, status: "failed" })).matchedCount).toBe(0);
  expect((await Conversation.findById(conversation._id)).bookingState.toObject()).toMatchObject({
    status: "booked", appointment: newer, expiresAt: null,
  });
  await expect(applyAppointmentBookingTransition(Conversation, "invalid", current)).rejects.toThrow(TypeError);
});
