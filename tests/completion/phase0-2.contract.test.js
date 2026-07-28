import fs from "fs";
import path from "path";

import Appointment from "../../src/models/appointment.js";
import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import Message from "../../src/models/message.js";

const root = process.cwd();
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const findIndex = (model, predicate) =>
  model.schema.indexes().find(([fields, options]) => predicate(fields, options));

const providerField = (fields, candidates) =>
  candidates.find((candidate) => Object.prototype.hasOwnProperty.call(fields, candidate));

const expectConcept = (source, label, alternatives) => {
  const normalized = source.toLowerCase();
  const matched = alternatives.some((alternative) => {
    if (alternative instanceof RegExp) {
      return alternative.test(normalized);
    }
    return normalized.includes(String(alternative).toLowerCase());
  });

  if (!matched) {
    throw new Error(
      `Missing ${label} coverage. Expected one of: ${alternatives
        .map((alternative) => alternative.toString())
        .join(", ")}`,
    );
  }
};

describe("CallBackIQ Phase 0-2 completion contract", () => {
  test("Phase 0 feature controls are represented in the business feature model", () => {
    const source = [
      read("src/models/business.js"),
      exists("src/models/businessFeatureSettings.js")
        ? read("src/models/businessFeatureSettings.js")
        : "",
    ].join("\n");
    for (const field of [
      "missedCallSmsEnabled",
      "aiQualificationEnabled",
      "aiBookingEnabled",
      "automatedFollowUpEnabled",
      "voiceAiEnabled",
      "revenueTrackingEnabled",
      "calendarProvider",
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toMatch(/internal/);
    expect(source).toMatch(/google/);
    expect(source).toMatch(/jobber/);
    expect(Business.schema).toBeDefined();
  });

  test("Phase 0 provider identifiers are protected by business-scoped unique indexes", () => {
    const messageIndex = findIndex(Message, (fields, options) => {
      const provider = providerField(fields, ["providerMessageId", "providerMessageSid"]);
      return Boolean(
        provider &&
          fields.business &&
          Object.keys(fields).length === 2 &&
          options?.unique,
      );
    });
    const callIndex = findIndex(CallLog, (fields, options) => {
      const provider = providerField(fields, ["providerCallId", "providerCallSid"]);
      return Boolean(
        provider &&
          fields.business &&
          Object.keys(fields).length === 2 &&
          options?.unique,
      );
    });

    expect(messageIndex).toBeDefined();
    expect(callIndex).toBeDefined();
    expect(Message.schema.path("business")?.options?.required).toBe(true);
    expect(Message.schema.path("conversation")?.options?.required).toBe(true);
  });

  test("Phase 0 behavioral completion tests are present", () => {
    for (const file of [
      "tests/integration/twilioWebhookIdempotency.test.js",
      "tests/integration/twilioOptOut.test.js",
      "tests/integration/providerUniqueIndexes.test.js",
      "tests/unit/aiReplyBookingSafety.test.js",
    ]) {
      expect(exists(file)).toBe(true);
    }

    const idempotency = read("tests/integration/twilioWebhookIdempotency.test.js");
    expect(idempotency).toMatch(/duplicate/i);
    expect(idempotency).toMatch(/voice/i);
    expect(idempotency).toMatch(/sms/i);
    expect(idempotency).toMatch(/conversation/i);

    const optOut = read("tests/integration/twilioOptOut.test.js");
    expect(optOut).toMatch(/STOP/i);
  });

  test("Phase 1 structured configuration models, routes, evaluator, and tests are present", () => {
    for (const file of [
      "src/models/serviceOffering.js",
      "src/models/availabilityRule.js",
      "src/models/availabilityException.js",
      "src/models/schedulingPolicy.js",
      "src/models/serviceArea.js",
      "src/models/businessOperationsSettings.js",
      "src/controllers/businessConfiguration.js",
      "src/routes/businessConfiguration.routes.js",
      "src/services/businessConfiguration.service.js",
      "src/services/bookingEligibility.service.js",
      "tests/routes/businessConfiguration.routes.test.js",
      "tests/services/bookingEligibility.service.test.js",
    ]) {
      expect(exists(file)).toBe(true);
    }

    const app = read("src/app.js");
    expect(app).toMatch(/business-configuration/);

    const evaluator = read("src/services/bookingEligibility.service.js");
    const phase1Concepts = [
      ["service matching", ["service"]],
      [
        "service-area ZIP/postal validation",
        ["postal", "zip code", "zip_code", "zipcode", "zipcodes"],
      ],
      ["appointment duration", ["duration"]],
      ["availability evaluation", ["availability"]],
      ["AI booking permission", ["aicanbook", "ai booking", "ai_booking"]],
      ["emergency escalation", ["emergency"]],
      ["human review or handoff", ["human"]],
    ];

    for (const [label, alternatives] of phase1Concepts) {
      expectConcept(evaluator, label, alternatives);
    }
  });

  test("Phase 2 appointment schema contains lifecycle fields and required unique indexes", () => {
    for (const field of [
      "business",
      "lead",
      "conversation",
      "serviceOffering",
      "customerName",
      "customerPhone",
      "startAt",
      "endAt",
      "timezone",
      "status",
      "source",
      "bookedBy",
      "provider",
      "externalAppointmentId",
      "externalCalendarId",
      "idempotencyKey",
      "failureReason",
      "confirmedAt",
      "canceledAt",
    ]) {
      expect(Appointment.schema.path(field)).toBeDefined();
    }

    const indexes = Appointment.schema.indexes();
    expect(
      indexes.some(
        ([fields, options]) =>
          fields.business && fields.idempotencyKey && options?.unique,
      ),
    ).toBe(true);
    expect(
      indexes.some(
        ([fields, options]) =>
          fields.provider && fields.externalAppointmentId && options?.unique,
      ),
    ).toBe(true);
    expect(
      indexes.some(
        ([fields, options]) =>
          fields.business && fields.slotClaimKeys && options?.unique,
      ),
    ).toBe(true);
  });

  test("Phase 2 uses a provider-neutral service architecture", () => {
    for (const file of [
      "src/integrations/scheduling/schedulingProvider.js",
      "src/integrations/scheduling/internalScheduling.provider.js",
      "src/services/scheduling/availability.service.js",
      "src/services/scheduling/appointment.service.js",
      "src/services/scheduling/appointmentPolicy.service.js",
      "src/services/scheduling/slotGenerator.service.js",
      "src/services/scheduling/schedulingProviderFactory.js",
      "src/routes/availability.routes.js",
      "src/routes/appointment.routes.js",
    ]) {
      expect(exists(file)).toBe(true);
    }

    const provider = read("src/integrations/scheduling/schedulingProvider.js");
    for (const method of [
      "getAvailability",
      "createAppointment",
      "updateAppointment",
      "cancelAppointment",
      "getAppointment",
      "testConnection",
    ]) {
      expect(provider).toContain(method);
    }

    const twilioControllerCandidates = [
      "src/controllers/twilio.js",
      "src/controllers/TwilioController.js",
      "src/controllers/twilio.controller.js",
    ];
    const twilioControllerPath = twilioControllerCandidates.find(exists);
    expect(twilioControllerPath).toBeDefined();
    const twilio = read(twilioControllerPath);
    expect(twilio).not.toMatch(/google\.calendar\.events\.insert/);
    const aiReply = read("src/services/aiReplyService.js");
    expect(aiReply).not.toMatch(/google\.calendar\.events\.insert/);
  });

  test("Phase 2 endpoints and controlled state transitions are present", () => {
    const routes = read("src/routes/appointment.routes.js");
    for (const endpoint of ["confirm", "cancel", "reschedule"]) {
      expect(routes).toContain(endpoint);
    }

    const service = read("src/services/scheduling/appointment.service.js");
    for (const transition of [
      'held: new Set(["confirmed", "failed"])',
      'confirmed: new Set(["canceled", "completed", "no_show", "rescheduled"])',
      "SLOT_ALREADY_CLAIMED",
      "heldExpiresAt",
      "slotClaimKeys",
      "idempotencyKey",
      "exactSlotAvailable",
    ]) {
      expect(service).toContain(transition);
    }
  });

  test("Phase 2 behavioral test matrix is present", () => {
    for (const file of [
      "tests/unit/timezone.service.test.js",
      "tests/unit/appointmentPolicy.service.test.js",
      "tests/unit/appointment.service.test.js",
      "tests/unit/internalScheduling.provider.test.js",
      "tests/unit/slotGenerator.service.test.js",
      "tests/integration/appointmentEngine.test.js",
    ]) {
      expect(exists(file)).toBe(true);
    }

    const corpus = [
      "tests/unit/timezone.service.test.js",
      "tests/unit/appointmentPolicy.service.test.js",
      "tests/unit/appointment.service.test.js",
      "tests/unit/internalScheduling.provider.test.js",
      "tests/unit/slotGenerator.service.test.js",
      "tests/integration/appointmentEngine.test.js",
    ]
      .map(read)
      .join("\n")
      .toLowerCase();

    const requiredConcepts = [
      [
        "timezone and daylight-saving behavior",
        [
          "daylight",
          "dst",
          "spring-forward",
          "spring forward",
          "fall-back",
          "fall back",
          "america/new_york",
          /2026-03-0[7-9]/,
          /2026-11-0[1-3]/,
        ],
      ],
      [
        "closed-day behavior",
        [
          "closed",
          "business_closed",
          "closed day",
          "disabled day",
          "enabled: false",
          "no operating window",
        ],
      ],
      [
        "service buffers",
        ["buffer", "bufferbeforeminutes", "bufferafterminutes"],
      ],
      [
        "same-day restrictions",
        ["same-day", "same day", "same_day", "allowsamedaybooking"],
      ],
      [
        "duplicate request idempotency",
        ["duplicate", "idempotent", "idempotency", "idempotencykey"],
      ],
      [
        "provider failure handling",
        [
          "provider failure",
          "provider fails",
          "provider error",
          "timeout",
          "failure",
          "failed",
          "createappointment.mockrejectedvalue",
        ],
      ],
      [
        "rescheduling",
        ["reschedule", "rescheduling", "rescheduled", "reschedul"],
      ],
      [
        "cancellation",
        ["cancel", "canceled", "cancelled", "cancellation"],
      ],
      [
        "atomic slot claiming and conflicts",
        [
          "slot claim",
          "slotclaim",
          "slot_claim",
          "slotalreadyclaimed",
          "slot_already_claimed",
          "conflict",
          "concurrent",
          "simultaneous",
        ],
      ],
    ];

    for (const [label, alternatives] of requiredConcepts) {
      expectConcept(corpus, label, alternatives);
    }
  });
});
