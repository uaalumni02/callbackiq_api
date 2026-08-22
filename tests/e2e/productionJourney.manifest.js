export const certificationStages = Object.freeze([
  {
    name: "registration and verification",
    assertions: [
      "user/business registration behavior",
      "password/authentication safety",
      "verification/auth route behavior",
    ],
    tests: [
      "tests/routes/auth.routes.test.js",
      "tests/validators/auth.test.js",
    ],
  },
  {
    name: "trial activation and lifecycle",
    assertions: [
      "one canonical trial/subscription",
      "trial telecom recovery",
      "trial lifecycle side effects remain idempotent",
    ],
    tests: [
      "tests/integration/trialTelecomRecovery.contract.test.js",
      "tests/integration/trialLifecycleWorker.sideEffects.test.js",
      "tests/unit/trialLifecycle.worker.hardening.test.js",
    ],
  },
  {
    name: "Twilio provisioning and A2P readiness",
    assertions: [
      "provisioning/A2P state is deterministic",
      "provider payload contract remains valid",
      "SMS readiness is not reported before compliance is ready",
    ],
    tests: [
      "tests/unit/a2pCustomerOnboarding.publicState.targetCoverage.test.js",
      "tests/routes/a2pEvents.hardening.test.js",
      "tests/unit/providerPayloadFixtures.contract.test.js",
    ],
  },
  {
    name: "missed-call recovery and initial SMS",
    assertions: [
      "Twilio webhook behavior",
      "duplicate webhooks do not duplicate work",
      "SMS worker delivery behavior",
    ],
    tests: [
      "tests/routes/twilio.routes.test.js",
      "tests/integration/twilioWebhookIdempotency.test.js",
      "tests/unit/smsProcessing.worker.hardening.test.js",
    ],
  },
  {
    name: "AI qualification and safe pricing",
    assertions: [
      "qualification remains deterministic at the tool boundary",
      "exact-price questions do not promise guaranteed pricing",
      "pricing requests do not execute booking actions accidentally",
    ],
    tests: [
      "tests/unit/qualifyLeadWithAI.hardening.test.js",
      "tests/integration/aiBookingConversationMatrix.completion.test.js",
      "tests/unit/aiReplyBookingSafety.test.js",
    ],
  },
  {
    name: "business hours and slot offering",
    assertions: [
      "closed/unavailable windows are rejected",
      "business timezone and scheduling policy are respected",
      "only valid appointment slots are offered",
    ],
    tests: [
      "tests/unit/appointmentPolicy.completion.test.js",
      "tests/unit/slotGenerator.service.test.js",
      "tests/integration/appointmentEngine.test.js",
    ],
  },
  {
    name: "appointment hold and owner approval",
    assertions: [
      "appointment holds are collision-safe",
      "owner confirmation/approval is recorded",
      "customer confirmation behavior is deterministic",
    ],
    tests: [
      "tests/unit/appointment.service.test.js",
      "tests/unit/createAppointment.tool.test.js",
      "tests/unit/phase2_8.controllers.full.test.js",
      "tests/unit/sendConfirmationSms.tool.test.js",
    ],
  },
  {
    name: "calendar synchronization and reminders",
    assertions: [
      "calendar provider create/update/delete contract",
      "calendar synchronization handles provider failures",
      "appointment side effects remain isolated",
    ],
    tests: [
      "tests/unit/googleCalendarProvider.test.js",
      "tests/unit/googleCalendarSync.targetCoverage.test.js",
      "tests/unit/appointment.service.test.js",
    ],
  },
  {
    name: "reschedule and cancellation",
    assertions: [
      "old slot is released when rescheduled",
      "cancellation transitions remain safe",
      "booking conversation does not duplicate appointment actions",
    ],
    tests: [
      "tests/unit/appointment.service.test.js",
      "tests/integration/aiBookingConversationMatrix.completion.test.js",
    ],
  },
  {
    name: "billing integrity",
    assertions: [
      "Stripe state transitions remain canonical",
      "duplicate webhook/subscription behavior is idempotent",
      "money-path billing behavior remains protected",
    ],
    tests: [
      "tests/routes/stripeSubscriptionStateMatrix.hardening.test.js",
      "tests/unit/subscriptionIntegrity.ordering.hardening.test.js",
      "tests/unit/subscriptionIntegrity.matrix.hardening.test.js",
      "tests/controllers/billing.moneyPaths.hardening.test.js",
    ],
  },
]);

export const providerContractGroups = Object.freeze([
  {
    name: "Twilio",
    tests: [
      "tests/unit/providerPayloadFixtures.contract.test.js",
      "tests/routes/twilio.routes.test.js",
      "tests/routes/a2pEvents.hardening.test.js",
      "tests/integration/twilioOptOut.test.js",
      "tests/integration/twilioWebhookIdempotency.test.js",
    ],
  },
  {
    name: "Stripe",
    tests: [
      "tests/routes/stripeSubscriptionStateMatrix.hardening.test.js",
      "tests/unit/subscriptionIntegrity.ordering.hardening.test.js",
      "tests/unit/subscriptionIntegrity.matrix.hardening.test.js",
      "tests/controllers/billing.moneyPaths.hardening.test.js",
    ],
  },
  {
    name: "Google Calendar",
    tests: [
      "tests/unit/googleCalendarProvider.test.js",
      "tests/unit/googleCalendarSync.targetCoverage.test.js",
    ],
  },
  {
    name: "OpenAI",
    tests: [
      "tests/unit/qualifyLeadWithAI.hardening.test.js",
      "tests/unit/aiReplyBookingSafety.test.js",
      "tests/unit/followUpAgent.hardening.test.js",
      "tests/integration/aiBookingConversationMatrix.completion.test.js",
    ],
  },
]);

export const allCertificationTests = () =>
  Array.from(
    new Set([
      ...certificationStages.flatMap((stage) => stage.tests),
      ...providerContractGroups.flatMap((group) => group.tests),
    ]),
  );
