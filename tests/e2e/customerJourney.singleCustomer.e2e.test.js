import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

jest.mock("../../src/services/twilioSmsService.js", () => ({
  sendSms: jest.fn(),
}));

jest.mock("../../src/services/twilioBusinessResolver.service.js", () => ({
  resolveBusinessByTwilioNumber: jest.fn(),
  resolveBusinessFromWebhookPhones: jest.fn(),
}));

jest.mock("../../src/services/webhooks/twilioWebhookEvent.service.js", () => ({
  claimTwilioWebhookEvent: jest.fn(),
  completeTwilioWebhookEvent: jest.fn(),
  failTwilioWebhookEvent: jest.fn(),
}));

jest.mock("../../src/services/messaging/smsProcessingQueue.service.js", () => ({
  enqueueInboundSmsJob: jest.fn(),
}));

jest.mock("../../src/services/conversationOrchestrator.service.js", () => ({
  __esModule: true,
  default: {
    process: jest.fn(),
  },
}));

jest.mock("../../src/services/scheduling/schedulingProviderFactory.js", () => ({
  __esModule: true,
  default: {
    getProvider: jest.fn(),
  },
}));

jest.mock("../../src/services/alert.service.js", () => {
  const RealAlertService = jest.requireActual("../../src/services/alert.service.js").default;
  return {
  __esModule: true,
  default: {
    createMissedCallAlert: jest.fn(),
    createCustomerReplyAlert: jest.fn(),
    // Persist the real review: the processor must never acknowledge an unsaved handoff.
    createHumanHandoffAlert: jest.fn(input => RealAlertService.createHumanHandoffAlert(input)),
    createAIReviewAlert: jest.fn(),
    createBookedJobAlert: jest.fn(),
    createSystemAlert: jest.fn(() => Promise.resolve({})),
  },
  };
});

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitAlertCreated: jest.fn(),
    emitAlertDeleted: jest.fn(),
    emitAlertUpdated: jest.fn(),
    emitAllAlertsRead: jest.fn(),
    emitCallCreated: jest.fn(),
    emitCallUpdated: jest.fn(),
    emitConversationCreated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
    emitLeadCreated: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitMessageCreated: jest.fn(),
    emitMessageUpdated: jest.fn(),
    emitToAdmins: jest.fn(),
    emitToBusiness: jest.fn(),
    initialize: jest.fn(),
    isInitialized: jest.fn(),
  },
}));

jest.mock("../../src/services/intervention.service.js", () => ({
  __esModule: true,
  default: {
    create: jest.fn().mockResolvedValue(null),
    integrationFailure: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: {
    schedule: jest.fn(),
  },
}));

jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: {
    markAppointmentBooked: jest.fn(),
    record: jest.fn(),
  },
}));

jest.mock("../../src/services/integrations/integrationSettings.service.js", () => ({
  getGoogleSettings: jest.fn(() => ({
    customerRemindersEnabled: true,
    reminderHours: [24, 2],
    postAppointmentFollowUpEnabled: true,
    postAppointmentFollowUpDelayHours: 2,
  })),
}));

jest.mock("../../src/helpers/businessFeatures.js", () => ({
  isBusinessFeatureEnabled: jest.fn(() => true),
}));

import Alert from "../../src/models/alert.js";
import Business from "../../src/models/business.js";
import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import CallLog from "../../src/models/callLog.js";
import Message from "../../src/models/message.js";
import Appointment from "../../src/models/appointment.js";
import AppointmentNotificationJob from "../../src/models/appointmentNotificationJob.js";
import ServiceArea from "../../src/models/serviceArea.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import AvailabilityRule from "../../src/models/availabilityRule.js";
import IntegrationConnection from "../../src/models/integrationConnection.js";

import {
  handleSmsRecoveryVoiceWebhook,
  handleInboundSmsWebhook,
} from "../../src/services/twilioSmsWebhook.service.js";

import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import { processNextAppointmentNotification } from "../../src/services/scheduling/appointmentNotification.service.js";
import { createAppointmentTool } from "../../src/helpers/ai/tools/createAppointment.tool.js";

import {
  generateInternalSlots,
} from "../../src/services/scheduling/slotGenerator.service.js";

import { sendSms } from "../../src/services/twilioSmsService.js";

import {
  resolveBusinessByTwilioNumber,
} from "../../src/services/twilioBusinessResolver.service.js";

import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
  failTwilioWebhookEvent,
} from "../../src/services/webhooks/twilioWebhookEvent.service.js";

import {
  enqueueInboundSmsJob,
} from "../../src/services/messaging/smsProcessingQueue.service.js";

import ConversationOrchestratorService from "../../src/services/conversationOrchestrator.service.js";
import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";

const CUSTOMER_PHONE = "+14045550199";
const TRACKING_PHONE = "+12125550110";
const CALL_SID = "CA_SINGLE_CUSTOMER_E2E_001";
const MESSAGE_SID = "SM_SINGLE_CUSTOMER_E2E_001";

const responseStub = () => {
  const res = {
    statusCode: 200,
    body: "",
    headers: {},
  };

  res.type = jest.fn(() => res);

  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });

  res.send = jest.fn((body) => {
    res.body = body;
    return res;
  });

  res.set = jest.fn((name, value) => {
    res.headers[name] = value;
    return res;
  });

  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });

  return res;
};

const addDays = (date, amount) =>
  new Date(date.getTime() + amount * 24 * 60 * 60 * 1000);

const dateKey = (date) =>
  date.toISOString().slice(0, 10);

describe("CallBackIQ single-customer complete lifecycle", () => {
  let mongo;
  let business;
  let ownerId;
  let service;
  let marketingSourceId;
  let trackingNumberId;
  let calendarProvider;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();

    await mongoose.connect(mongo.getUri());
    await Alert.init();

    ownerId = new mongoose.Types.ObjectId();

    const businessId =
      new mongoose.Types.ObjectId();

    await Business.collection.insertOne({
      _id: businessId,
      owner: ownerId,
      businessName: "Single Customer Plumbing",
      businessType: "plumbing",
      phone: TRACKING_PHONE,
      phoneLookup: TRACKING_PHONE,
      timezone: "America/New_York",
      isActive: true,
      estimatedJobValue: 250,
      features: {
        missedCallSmsEnabled: true,
        aiQualificationEnabled: true,
        calendarProvider: "internal",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    business =
      await Business.findById(businessId);

    await IntegrationConnection.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      business: business._id,
      provider: "google_calendar",
      status: "connected",
      connectionStatus: "connected",
      calendarId: "calendar_single_customer",
      bookingCalendarId: "calendar_single_customer",
      availabilityCalendarIds: [
        "calendar_single_customer",
      ],
      settings: {
        customerRemindersEnabled: true,
        reminderHours: [24, 2],
        postAppointmentFollowUpEnabled: true,
        postAppointmentFollowUpDelayHours: 2,
      },
      metadata: {
        testMarker:
          "E2E_FAKE_GOOGLE_CONNECTION",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    service =
      await ServiceOffering.create({
        business: business._id,
        name: "General Plumbing Service",
        category: "plumbing",
        description:
          "General plumbing diagnostic and service.",
        active: true,
        aiCanDiscuss: true,
        aiCanBook: true,
        durationMinutes: 90,
        estimatedValue: 250,
        emergencyEligible: true,
        requiresHumanReview: false,
        keywords: [
          "plumbing",
          "pipe",
          "leak",
          "drain",
        ],
      });

    // This journey offers and books a visit at ZIP 30318. Missing service-area
    // configuration intentionally requires staff review in the real policy.
    await ServiceArea.create({
      business: business._id,
      type: "zip_codes",
      zipCodes: ["30318"],
    });

    const futureDate =
      addDays(new Date(), 7);

    const futureDateKey =
      dateKey(futureDate);

    const dayOfWeek =
      new Date(
        `${futureDateKey}T12:00:00.000Z`
      ).getUTCDay();

    await AvailabilityRule.create({
      business: business._id,
      dayOfWeek,
      enabled: true,
      windows: [
        {
          startTime: "09:00",
          endTime: "17:00",
          allDay: false,
        },
      ],
      timezone: "America/New_York",
      capacity: 1,
    });

    marketingSourceId =
      new mongoose.Types.ObjectId();

    trackingNumberId =
      new mongoose.Types.ObjectId();

    resolveBusinessByTwilioNumber
      .mockResolvedValue(business);

    sendSms.mockImplementation(
      async ({ body }) => ({
        sid:
          `SM_FAKE_${String(
            sendSms.mock.calls.length
          ).padStart(4, "0")}`,
        status: "sent",
        body,
        segmentCount: 1,
        encoding: "GSM-7",
        suppressed: false,
      })
    );

    claimTwilioWebhookEvent
      .mockImplementation(async () => ({
        claimed: true,
        event: {
          _id: new mongoose.Types.ObjectId(),
          business: business._id,
        },
      }));

    completeTwilioWebhookEvent
      .mockResolvedValue(true);

    enqueueInboundSmsJob
      .mockImplementation(
        async ({
          businessId,
          inboundMessageId,
          conversationId,
          leadId,
          providerMessageId,
        }) => ({
          _id: new mongoose.Types.ObjectId(),
          business: businessId,
          inboundMessage: inboundMessageId,
          conversation: conversationId,
          lead: leadId,
          providerMessageId,
        })
      );

    ConversationOrchestratorService.process
      .mockResolvedValue({
        result: {
          decision: "reply",
          // The orchestrator boundary represents completed, qualified intake.
          intakeReady: true,
          messageCategory:
            "service_request",
          reply:
            "A rough estimate for this type of plumbing work may be around $250, but the final price can vary after the technician evaluates the problem. I have your Atlanta 30318 address and urgent service request.",
          serviceNeeded:
            "General Plumbing Service",
          urgency: "high",
          address:
            "123 Peachtree Street, Atlanta, GA 30318",
          preferredAppointmentTime:
            "Next available appointment",
          summary:
            "Urgent plumbing service requested for a leaking pipe in ZIP 30318.",
          estimatedValue: 250,
          leadQualityScore: 90,
          shouldAlertOwner: false,
          riskFlags: [],
        },
      });

    calendarProvider = {
      /*
       * Deterministic provider-side availability.
       *
       * CallBackIQ's own availability/business-hours logic remains real.
       * This only replaces the external calendar availability boundary.
       */
      /*
       * Mirror the real scheduling provider contract:
       * generate CallBackIQ's actual internal business-hours slots,
       * while skipping only the external calendar/network boundary.
       */
      getAvailability: jest.fn(async (options = {}) => {
        return generateInternalSlots({
          ...options,
          business,
        });
      }),

      createAppointment:
        jest.fn(
          async ({ appointment }) => ({
            provider:
              "google_calendar",
            externalAppointmentId:
              `evt_${appointment._id}`,
            externalCalendarId:
              "calendar_single_customer",
          })
        ),

      updateAppointment:
        jest.fn(
          async ({ appointment }) => ({
            provider:
              "google_calendar",
            externalAppointmentId:
              appointment.externalAppointmentId ||
              `evt_${appointment._id}`,
            externalCalendarId:
              "calendar_single_customer",
          })
        ),

      cancelAppointment:
        jest.fn(async () => ({
          canceled: true,
        })),
    };

    SchedulingProviderFactory.getProvider
      .mockReturnValue(calendarProvider);
  });

  afterAll(async () => {
    await mongoose.disconnect();

    if (mongo) {
      await mongo.stop();
    }
  });

  test(
    "one synthetic customer travels from missed call through cancellation without losing lineage",
    async () => {
      const voiceReq = {
        body: {
          From: CUSTOMER_PHONE,
          Caller: CUSTOMER_PHONE,
          To: TRACKING_PHONE,
          Called: TRACKING_PHONE,
          CallSid: CALL_SID,
        },
        app: {},
      };

      const voiceRes = responseStub();

      await handleSmsRecoveryVoiceWebhook(
        voiceReq,
        voiceRes
      );

      expect(voiceRes.statusCode)
        .toBe(200);

      const leadsAfterMissedCall =
        await Lead.find({
          business: business._id,
          phone: CUSTOMER_PHONE,
        });

      expect(leadsAfterMissedCall)
        .toHaveLength(1);

      const lead =
        leadsAfterMissedCall[0];

      const conversationsAfterMissedCall =
        await Conversation.find({
          business: business._id,
          customerPhone: CUSTOMER_PHONE,
        });

      expect(
        conversationsAfterMissedCall
      ).toHaveLength(1);

      const conversation =
        conversationsAfterMissedCall[0];

      expect(
        String(conversation.lead)
      ).toBe(String(lead._id));

      let call =
        await CallLog.findOne({
          business: business._id,
          providerCallId: CALL_SID,
        });

      expect(call)
        .toBeTruthy();

      expect(String(call.lead))
        .toBe(String(lead._id));

      expect(String(call.conversation))
        .toBe(
          String(conversation._id)
        );

      const recoveryMessage =
        await Message.findOne({
          business: business._id,
          conversation:
            conversation._id,
          lead: lead._id,
          direction: "outbound",
        }).sort({
          createdAt: 1,
        });

      expect(recoveryMessage)
        .toBeTruthy();

      expect(
        recoveryMessage.generatedBy
      ).toBe("automation");

      await CallLog.updateOne(
        { _id: call._id },
        {
          $set: {
            marketingSource:
              marketingSourceId,
            trackingNumber:
              trackingNumberId,
            attribution: {
              sourceId:
                String(marketingSourceId),
              sourceName:
                "Google Ads",
              channel:
                "paid_search",
              campaign:
                "Single Customer E2E",
              trackingNumberId:
                String(trackingNumberId),
              trackingNumber:
                TRACKING_PHONE,
            },
          },
        }
      );

      await Lead.updateOne(
        { _id: lead._id },
        {
          $set: {
            firstMarketingSource:
              marketingSourceId,
            firstTrackingNumber:
              trackingNumberId,
            firstAttribution: {
              sourceId:
                String(marketingSourceId),
              sourceName:
                "Google Ads",
              channel:
                "paid_search",
              campaign:
                "Single Customer E2E",
              trackingNumberId:
                String(trackingNumberId),
              trackingNumber:
                TRACKING_PHONE,
            },
            latestMarketingSource:
              marketingSourceId,
            latestTrackingNumber:
              trackingNumberId,
            latestAttribution: {
              sourceId:
                String(marketingSourceId),
              sourceName:
                "Google Ads",
              channel:
                "paid_search",
              campaign:
                "Single Customer E2E",
              trackingNumberId:
                String(trackingNumberId),
              trackingNumber:
                TRACKING_PHONE,
            },
          },
        }
      );

      const inboundReq = {
        body: {
          From: CUSTOMER_PHONE,
          To: TRACKING_PHONE,
          Body:
            "I have a leaking pipe at 123 Peachtree Street, Atlanta GA 30318. It is urgent. What might it cost, and can I book someone?",
          MessageSid: MESSAGE_SID,
          SmsSid: MESSAGE_SID,
        },
        app: {},
      };

      const inboundRes =
        responseStub();

      await handleInboundSmsWebhook(
        inboundReq,
        inboundRes
      );

      if (inboundRes.statusCode !== 200) {
        const failure = failTwilioWebhookEvent.mock.calls.at(-1)?.[1];
        throw failure || new Error(`Inbound SMS returned ${inboundRes.statusCode} without a captured webhook error.`);
      }
      expect(inboundRes.statusCode)
        .toBe(200);

      const reviewConversation = await Conversation.findById(conversation._id).lean();
      const reviewId = reviewConversation.conversationMemory?.recoveryIntake?.review?.alertId;
      expect(reviewId).toBeTruthy();
      const savedReview = await Alert.findOne({
        _id: reviewId, business: business._id, conversation: conversation._id, lead: lead._id,
      }).lean();
      expect(savedReview).toMatchObject({ actionRequired: true, type: "human_requested" });
      expect(reviewConversation.conversationMemory.recoveryIntake.review.status).toBe("queued");

      const leadsAfterReply =
        await Lead.find({
          business: business._id,
          phone: CUSTOMER_PHONE,
        });

      expect(leadsAfterReply)
        .toHaveLength(1);

      const conversationsAfterReply =
        await Conversation.find({
          business: business._id,
          customerPhone: CUSTOMER_PHONE,
        });

      expect(
        conversationsAfterReply
      ).toHaveLength(1);

      const updatedLead =
        await Lead.findById(
          lead._id
        );

      expect(updatedLead.serviceNeeded)
        .toMatch(/plumbing/i);

      expect(updatedLead.urgency)
        .toBe("high");

      expect(updatedLead.address)
        .toContain("30318");

      expect(
        updatedLead.estimatedValue
      ).toBe(250);

      expect(
        String(
          updatedLead.latestMarketingSource
        )
      ).toBe(
        String(marketingSourceId)
      );

      const inboundMessage =
        await Message.findOne({
          business: business._id,
          providerMessageId:
            MESSAGE_SID,
        });

      expect(inboundMessage)
        .toBeTruthy();

      expect(
        String(inboundMessage.lead)
      ).toBe(String(lead._id));

      expect(
        String(
          inboundMessage.conversation
        )
      ).toBe(
        String(conversation._id)
      );

      const aiReply =
        await Message.findOne({
          business: business._id,
          conversation:
            conversation._id,
          inReplyToMessage:
            inboundMessage._id,
        });

      expect(aiReply)
        .toBeTruthy();

      // Internal value is not an approved customer-facing quote.
      // Keep the separate $250 persisted-value assertion above.
      expect(aiReply.body).toMatch(/service request is saved/i);
      expect(aiReply.body).toMatch(/needs business confirmation/i);
      expect(aiReply.body).not.toMatch(/\$\s*250\b|rough estimate/i);

      const future =
        addDays(new Date(), 7);

      const bookingDate =
        dateKey(future);

      const slots =
        await generateInternalSlots({
          business,
          serviceOfferingId:
            service._id,
          startDate: bookingDate,
          endDate: bookingDate,
          now: new Date(),
        });

      expect(slots.length)
        .toBeGreaterThan(3);

      const firstSlot =
        slots[0];

      const replacementSlot =
        slots.find(
          (slot) =>
            new Date(
              slot.startAt
            ).getTime() >=
            new Date(
              firstSlot.endAt
            ).getTime()
        );

      expect(replacementSlot)
        .toBeTruthy();

      const outsideStart =
        new Date(
          new Date(
            firstSlot.startAt
          ).getTime() -
            6 * 60 * 60 * 1000
        );

      const outsideEnd =
        new Date(
          outsideStart.getTime() +
            90 * 60 * 1000
        );

      await expect(
        AppointmentService.create({
          business,
          confirm: false,
          idempotencyKey:
            "single-customer-outside-hours",
          input: {
            lead: lead._id,
            conversation:
              conversation._id,
            serviceOfferingId:
              service._id,
            customerName:
              "Single Customer",
            customerPhone:
              CUSTOMER_PHONE,
            startAt:
              outsideStart,
            endAt:
              outsideEnd,
            timezone:
              "America/New_York",
            address: {
              street:
                "123 Peachtree Street",
              city: "Atlanta",
              state: "GA",
              postalCode:
                "30318",
            },
            source: "sms",
            bookedBy:
              "customer",
            estimatedValue:
              250,
          },
        })
      ).rejects.toMatchObject({
        code: "SLOT_UNAVAILABLE",
      });

      const hold =
        await createAppointmentTool({
          business,
          idempotencyKey:
            "single-customer-hold",
          input: {
            lead: lead._id,
            conversation:
              conversation._id,
            serviceOfferingId:
              service._id,
            customerName:
              "Single Customer",
            customerPhone:
              CUSTOMER_PHONE,
            startAt:
              firstSlot.startAt,
            endAt:
              firstSlot.endAt,
            timezone:
              firstSlot.timezone ||
              "America/New_York",
            address: {
              street:
                "123 Peachtree Street",
              city: "Atlanta",
              state: "GA",
              postalCode:
                "30318",
            },
            source: "sms",
            bookedBy:
              "customer",
            estimatedValue:
              250,
          },
        });

      expect(hold.status)
        .toBe("held");

      expect(
        hold.requiresBusinessApproval
      ).toBe(true);

      expect(
        hold.approvalRequestedAt
      ).toBeTruthy();

      expect(String(hold.lead))
        .toBe(String(lead._id));

      expect(
        String(hold.conversation)
      ).toBe(
        String(conversation._id)
      );

      expect(
        String(hold.marketingSource)
      ).toBe(
        String(marketingSourceId)
      );

      expect(
        String(hold.trackingNumber)
      ).toBe(
        String(trackingNumberId)
      );

      const confirmed =
        await AppointmentService.confirm({
          business,
          appointmentId:
            hold._id,
          approvedBy: ownerId,
        });

      expect(confirmed.status)
        .toBe("confirmed");

      expect(
        String(confirmed.lead)
      ).toBe(String(lead._id));

      expect(
        String(
          confirmed.conversation
        )
      ).toBe(
        String(conversation._id)
      );

      expect(
        confirmed.externalAppointmentId
      ).toBeTruthy();

      expect(
        confirmed.externalCalendarId
      ).toBe(
        "calendar_single_customer"
      );

      expect(
        calendarProvider
          .createAppointment
      ).toHaveBeenCalledTimes(1);

      const notificationsAfterConfirm =
        await AppointmentNotificationJob.find({
          appointment:
            confirmed._id,
        }).lean();

      const scheduledReminder =
        notificationsAfterConfirm.some(
          (job) =>
            job.status ===
              "scheduled" &&
            Object.values(job).includes(
              "reminder"
            )
        );

      expect(scheduledReminder)
        .toBe(true);

      const immediateConfirmation =
        await Message.findOne({
          business: business._id,
          conversation:
            conversation._id,
          direction: "outbound",
          createdAt: {
            $gte:
              confirmed.confirmedAt ||
              new Date(0),
          },
        });

      const scheduledChangeNotice =
        notificationsAfterConfirm.some(
          (job) =>
            Object.values(job)
              .includes(
                "change_notice"
              )
        );

      expect(
        Boolean(
          immediateConfirmation
        ) ||
          scheduledChangeNotice
      ).toBe(true);

      expect(
        String(
          confirmed.marketingSource
        )
      ).toBe(
        String(marketingSourceId)
      );

      expect(
        String(
          confirmed.trackingNumber
        )
      ).toBe(
        String(trackingNumberId)
      );

      expect(
        confirmed.estimatedValue
      ).toBe(250);

      const replacement =
        await AppointmentService.reschedule({
          business,
          appointmentId:
            confirmed._id,
          idempotencyKey:
            "single-customer-reschedule",
          input: {
            startAt:
              replacementSlot.startAt,
            endAt:
              replacementSlot.endAt,
            timezone:
              replacementSlot.timezone ||
              "America/New_York",
            address: {
              street:
                "123 Peachtree Street",
              city: "Atlanta",
              state: "GA",
              postalCode:
                "30318",
            },
          },
        });

      expect(replacement.status)
        .toBe("confirmed");

      expect(
        String(replacement.lead)
      ).toBe(String(lead._id));

      expect(
        String(
          replacement.conversation
        )
      ).toBe(
        String(conversation._id)
      );

      expect(
        String(
          replacement.rescheduledFrom
        )
      ).toBe(
        String(confirmed._id)
      );

      const oldAppointment =
        await Appointment.findById(
          confirmed._id
        );

      expect(oldAppointment.status)
        .toBe("rescheduled");

      // A reschedule updates the existing provider event. The replacement
      // becomes the sole active owner of that provider event ID.
      expect(
        replacement.externalAppointmentId
      ).toBe(
        confirmed.externalAppointmentId
      );

      expect(
        replacement.pendingRescheduleExternalAppointmentId
      ).toBeNull();

      expect(
        replacement.pendingRescheduleExternalCalendarId
      ).toBeNull();

      expect(
        oldAppointment.externalAppointmentId
      ).toBeNull();

      expect(
        oldAppointment.externalCalendarId
      ).toBeNull();

      expect(
        String(
          oldAppointment.rescheduledTo
        )
      ).toBe(
        String(replacement._id)
      );

      expect(
        calendarProvider
          .updateAppointment
      ).toHaveBeenCalledTimes(1);

      expect(
        String(
          replacement.marketingSource
        )
      ).toBe(
        String(marketingSourceId)
      );

      expect(
        String(
          replacement.trackingNumber
        )
      ).toBe(
        String(trackingNumberId)
      );

      const oldScheduledReminders =
        await AppointmentNotificationJob.countDocuments({
          appointment:
            confirmed._id,
          status: "scheduled",
        });

      expect(
        oldScheduledReminders
      ).toBe(0);

      const replacementNotifications =
        await AppointmentNotificationJob.find({
          appointment:
            replacement._id,
        }).lean();

      expect(
        replacementNotifications.some(
          (job) =>
            job.status ===
              "scheduled" &&
            Object.values(job).includes(
              "reminder"
            )
        )
      ).toBe(true);

      const canceled =
        await AppointmentService.cancel({
          business,
          appointmentId:
            replacement._id,
          reason:
            "Customer canceled synthetic E2E appointment.",
        });

      expect(canceled.status)
        .toBe("canceled");

      expect(
        calendarProvider
          .cancelAppointment
      ).toHaveBeenCalledTimes(1);

      // Cancellation ends reminders/follow-ups, while the durable cancellation
      // notice must remain queued until a worker records provider acceptance.
      const pendingAfterCancel =
        await AppointmentNotificationJob.countDocuments({
          business: business._id,
          appointment:
            replacement._id,
          type: { $in: ["reminder", "follow_up"] },
          status: { $in: ["scheduled", "processing"] },
        });

      expect(pendingAfterCancel)
        .toBe(0);

      const cancellationKey = "change_notice:lifecycle_canceled";
      const cancellationNotices = await AppointmentNotificationJob.find({
        business: business._id,
        appointment: replacement._id,
        key: cancellationKey,
      }).lean();
      expect(cancellationNotices).toHaveLength(1);
      expect(cancellationNotices[0]).toMatchObject({
        type: "change_notice", status: "scheduled",
      });
      expect(cancellationNotices[0].body).toContain("has been canceled");

      // Process the real persisted queue. A superseded confirmation/reschedule
      // must be discarded, and only the current cancellation may be sent.
      const sendsBeforeCancellationWorker = sendSms.mock.calls.length;
      for (let processed = 0; processed < 20; processed += 1) {
        if (!(await processNextAppointmentNotification())) break;
      }
      const sendsAfterCancellation = sendSms.mock.calls
        .slice(sendsBeforeCancellationWorker)
        .map(([input]) => input);
      expect(sendsAfterCancellation).toHaveLength(1);
      expect(sendsAfterCancellation[0]).toMatchObject({
        to: CUSTOMER_PHONE,
        source: "appointment_change_notice",
        metadata: { appointmentNotificationKey: cancellationKey },
      });
      expect(sendsAfterCancellation[0].body).toContain("has been canceled");
      expect(await AppointmentNotificationJob.countDocuments({
        business: business._id,
        appointment: replacement._id,
        status: { $in: ["scheduled", "processing"] },
      })).toBe(0);
      expect(await AppointmentNotificationJob.countDocuments({
        business: business._id,
        appointment: replacement._id,
        key: cancellationKey,
        status: "sent",
      })).toBe(1);
      expect(await Message.countDocuments({
        business: business._id,
        conversation: conversation._id,
        direction: "outbound",
        "metadata.appointmentId": String(replacement._id),
        "metadata.appointmentNotificationKey": cancellationKey,
      })).toBe(1);

      // A retried cancellation must retain the same completed notice and must
      // not delete the provider event or text the customer again.
      await AppointmentService.cancel({
        business, appointmentId: replacement._id,
        reason: "Customer canceled synthetic E2E appointment.",
      });
      expect(await processNextAppointmentNotification()).toBeNull();
      expect(calendarProvider.cancelAppointment).toHaveBeenCalledTimes(1);
      expect(sendSms.mock.calls.length).toBe(sendsBeforeCancellationWorker + 1);
      expect(await AppointmentNotificationJob.countDocuments({
        business: business._id,
        appointment: replacement._id,
        key: cancellationKey,
      })).toBe(1);

      const finalLeadCount =
        await Lead.countDocuments({
          business: business._id,
          phone: CUSTOMER_PHONE,
        });

      const finalConversationCount =
        await Conversation.countDocuments({
          business: business._id,
          customerPhone:
            CUSTOMER_PHONE,
        });

      const journeyAppointments =
        await Appointment.find({
          business: business._id,
          lead: lead._id,
          conversation:
            conversation._id,
        }).sort({
          createdAt: 1,
        });

      expect(finalLeadCount)
        .toBe(1);

      expect(
        finalConversationCount
      ).toBe(1);

      /*
       * Two appointment documents are correct here:
       * the original is retained as "rescheduled", and
       * the replacement points back to it.
       */
      expect(
        journeyAppointments
      ).toHaveLength(2);

      expect(
        journeyAppointments[0]
          .status
      ).toBe("rescheduled");

      expect(
        journeyAppointments[1]
          .status
      ).toBe("canceled");

      expect(
        String(
          journeyAppointments[1]
            .rescheduledFrom
        )
      ).toBe(
        String(
          journeyAppointments[0]
            ._id
        )
      );

      call =
        await CallLog.findById(
          call._id
        );

      expect(
        String(call.lead)
      ).toBe(String(lead._id));

      expect(
        String(call.conversation)
      ).toBe(
        String(conversation._id)
      );

      expect(
        String(
          call.marketingSource
        )
      ).toBe(
        String(marketingSourceId)
      );

      console.log("");
      console.log(
        "CALLBACKIQ SINGLE CUSTOMER JOURNEY"
      );
      console.log(
        "-----------------------------------"
      );
      console.log(
        `Customer:       ${CUSTOMER_PHONE}`
      );
      console.log(
        `Call:           ${call._id}`
      );
      console.log(
        `Lead:           ${lead._id}`
      );
      console.log(
        `Conversation:   ${conversation._id}`
      );
      console.log(
        "Qualification:  ✓ Plumbing / High / 30318"
      );
      console.log(
        "Pricing:        ✓ Safe estimate"
      );
      console.log(
        "Attribution:    ✓ Google Ads preserved"
      );
      console.log(
        "Business hours: ✓ Closed time rejected"
      );
      console.log(
        "Availability:   ✓ Slots generated"
      );
      console.log(
        "Hold:           ✓"
      );
      console.log(
        "Approval:       ✓"
      );
      console.log(
        "Confirmation:   ✓"
      );
      console.log(
        "Calendar create:✓"
      );
      console.log(
        "Reminder:       ✓"
      );
      console.log(
        "Reschedule:     ✓"
      );
      console.log(
        "Calendar update:✓"
      );
      console.log(
        "Cancel:         ✓"
      );
      console.log(
        "Cleanup:        ✓"
      );
      console.log(
        "Lead duplicates:0"
      );
      console.log(
        "Conversation duplicates: 0"
      );
      console.log("");
      console.log(
        "ONE CUSTOMER — COMPLETE JOURNEY PASSED"
      );
    },
    60000
  );
});
