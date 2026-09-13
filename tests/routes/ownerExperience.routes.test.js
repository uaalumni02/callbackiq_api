import request from "supertest";

import app from "../../src/app.js";
import Alert from "../../src/models/alert.js";
import Appointment from "../../src/models/appointment.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import Subscription from "../../src/models/subscription.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const registerBusiness = async () => {
  const response = await request(app).post("/api/auth/register").send({
    userName: "ownerexperience",
    email: "owner-experience@callbackiq.com",
    password: "Password123",
    role: "owner",
    businessName: "Owner Experience Plumbing",
    businessPhone: "4045551234",
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  const business = response.body.data.business;
  await Subscription.findOneAndUpdate(
    { business: business._id },
    {
      $set: {
        status: "active",
        isActive: true,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    },
  );

  return {
    token: response.body.data.token,
    business,
  };
};

const authGet = (path, token) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

describe("Owner experience routes", () => {
  test("dashboard Today period excludes older missed calls", async () => {
    const { token, business } = await registerBusiness();
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);

    await CallLog.create({
      business: business._id,
      from: "+14045550101",
      to: "+14045551234",
      direction: "inbound",
      status: "missed",
      provider: "twilio",
      createdAt: now,
      updatedAt: now,
    });

    await CallLog.create({
      business: business._id,
      from: "+14045550102",
      to: "+14045551234",
      direction: "inbound",
      status: "missed",
      provider: "twilio",
      createdAt: threeDaysAgo,
      updatedAt: threeDaysAgo,
    });

    const response = await authGet("/api/owner/dashboard?period=today", token);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.period.key).toBe("today");
    expect(response.body.data.period.label).toBe("Today");
    expect(response.body.data.outcomes.missedCalls).toBe(1);
  });

  test("opportunity inbox exposes persisted customer preference and availability evidence", async () => {
    const { token, business } = await registerBusiness();
    const checkedAt = new Date();
    const slotStart = new Date(checkedAt.getTime() + 24 * 60 * 60 * 1000);
    const slotEnd = new Date(slotStart.getTime() + 90 * 60 * 1000);

    const activeLead = await Lead.create({
      business: business._id,
      customerName: "Jane Customer",
      phone: "+14045550111",
      serviceNeeded: "Water heater repair",
      urgency: "high",
      status: "contacted",
      source: "missed_call",
      summary: "Water heater is leaking and the customer wants service tomorrow.",
      firstRespondedAt: checkedAt,
      estimatedValue: 950,
    });

    await Conversation.create({
      business: business._id,
      lead: activeLead._id,
      customerName: "Jane Customer",
      customerPhone: "+14045550111",
      status: "open",
      lastMessage: "Tomorrow afternoon works best.",
      lastMessageAt: checkedAt,
      bookingState: {
        status: "offering_slots",
        lastCustomerPreference: "tomorrow afternoon",
        lastAvailabilityCheckedAt: checkedAt,
        offeredSlots: [
          {
            startAt: slotStart,
            endAt: slotEnd,
            timezone: "America/New_York",
            label: "Tomorrow at 2:00 PM",
          },
        ],
      },
    });

    await Lead.create({
      business: business._id,
      customerName: "Closed Customer",
      phone: "+14045550112",
      serviceNeeded: "Drain cleaning",
      status: "lost",
      source: "missed_call",
    });

    const response = await authGet("/api/owner/opportunities?view=active", token);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.stats.active).toBe(1);
    expect(response.body.data.items[0]).toMatchObject({
      customerName: "Jane Customer",
      summary: "Water heater is leaking and the customer wants service tomorrow.",
      status: "contacted",
      booking: {
        stage: "offering_slots",
        stageLabel: "Times offered",
        customerPreference: "tomorrow afternoon",
        customerAvailabilityCaptured: true,
        availabilityChecked: true,
      },
      nextAction: {
        label: "Waiting for customer",
        requiresOwner: false,
      },
    });
    expect(response.body.data.items[0].booking.offeredSlots).toHaveLength(1);
  });


  test("Needs me view agrees with unresolved intervention records", async () => {
    const { token, business } = await registerBusiness();

    const lead = await Lead.create({
      business: business._id,
      customerName: "Owner Action Customer",
      phone: "+14045550131",
      serviceNeeded: "Electrical repair",
      status: "contacted",
      source: "missed_call",
      estimatedValue: 1200,
    });

    await Alert.create({
      business: business._id,
      lead: lead._id,
      type: "human_requested",
      title: "Customer requested staff",
      message: "Customer asked to speak with a person.",
      reason: "The customer explicitly requested a human.",
      recommendedAction: "Call the customer now.",
      priority: "high",
      actionRequired: true,
      status: "sent",
    });

    const response = await authGet("/api/owner/opportunities?view=needs_me", token);

    expect(response.status).toBe(200);
    expect(response.body.data.stats.needsMe).toBe(1);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      needsAttention: true,
      nextAction: {
        label: "Staff action required",
        requiresOwner: true,
      },
    });
  });

  test("appointments expose the conversation booking evidence without changing booking behavior", async () => {
    const { token, business } = await registerBusiness();
    const now = new Date();
    const startAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 90 * 60 * 1000);

    const service = await ServiceOffering.create({
      business: business._id,
      name: "Leak repair",
      category: "plumbing",
      durationMinutes: 90,
      active: true,
      aiCanBook: true,
    });

    const lead = await Lead.create({
      business: business._id,
      customerName: "Sam Homeowner",
      phone: "+14045550121",
      serviceNeeded: "Leak repair",
      status: "booked",
      source: "missed_call",
      recovered: true,
      recoveredBy: "sms_ai",
      summary: "Kitchen leak; customer requested Friday afternoon.",
      preferredAppointmentTime: "Friday afternoon",
      bookedAt: now,
      estimatedValue: 700,
    });

    const conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      customerName: "Sam Homeowner",
      customerPhone: "+14045550121",
      status: "open",
      bookingState: {
        status: "booked",
        serviceOffering: service._id,
        lastCustomerPreference: "Friday afternoon",
        lastAvailabilityCheckedAt: now,
        offeredSlots: [
          {
            startAt,
            endAt,
            timezone: "America/New_York",
            label: "Friday at 2:00 PM",
          },
        ],
        selectedSlot: {
          startAt,
          endAt,
          timezone: "America/New_York",
          label: "Friday at 2:00 PM",
        },
      },
    });

    const appointment = await Appointment.create({
      business: business._id,
      lead: lead._id,
      conversation: conversation._id,
      serviceOffering: service._id,
      customerName: "Sam Homeowner",
      customerPhone: "+14045550121",
      startAt,
      endAt,
      timezone: "America/New_York",
      status: "confirmed",
      source: "sms",
      bookedBy: "ai",
      provider: "internal",
      idempotencyKey: `owner-evidence-${conversation._id}`,
      confirmedAt: now,
      estimatedValue: 700,
    });

    conversation.bookingState.appointment = appointment._id;
    await conversation.save();

    const response = await authGet("/api/appointments?status=confirmed", token);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].lead).toMatchObject({
      summary: "Kitchen leak; customer requested Friday afternoon.",
      recovered: true,
      recoveredBy: "sms_ai",
    });
    expect(response.body.data[0].conversation.bookingState).toMatchObject({
      status: "booked",
      lastCustomerPreference: "Friday afternoon",
    });
    expect(response.body.data[0].conversation.bookingState.offeredSlots).toHaveLength(1);
    expect(response.body.data[0].conversation.bookingState.selectedSlot.label).toBe("Friday at 2:00 PM");
  });
});
