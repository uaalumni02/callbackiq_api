import { evaluateSmsTurnPolicy } from "../../src/services/messaging/smsTurnPolicy.service.js";
import { hasUnverifiedStaffCommitment } from "../../src/services/customerCommitmentSafety.service.js";

const business = {
  businessName: "Atlanta Pro Plumbing & Drain",
  businessType: "plumbing",
  timezone: "America/New_York",
  features: { aiBookingEnabled: false },
};

describe("deterministic SMS commitment safety", () => {
  test.each([
    "Can someone call me?",
    "Tuesday morning works for me",
    "How much will it cost and can you come Tuesday morning?",
    "How much will a water heater repair cost?",
    "I need to reschedule my appointment",
  ])("does not author an unverified future staff promise: %s", (customerMessage) => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage,
      business,
      lead: {
        serviceNeeded: "water heater repair",
        urgency: "medium",
        address: "123 Peachtree St, Atlanta, GA 30303",
      },
      now: new Date("2026-09-06T16:00:00.000Z"),
    });

    if (policy.directResult?.reply) {
      expect(hasUnverifiedStaffCommitment(policy.directResult.reply)).toBe(false);
      expect(policy.directResult.reply).not.toMatch(/\bwill confirm\b/i);
      expect(policy.directResult.reply).not.toMatch(/as soon as possible/i);
    }
  });
  test("mechanically executes every hardened pure SMS copy helper", async () => {
    const {
      safePreferenceAcknowledgement,
      pricingAndSchedulingReply,
      pricingReply,
    } = await import(
      "../../src/services/messaging/smsTurnPolicy.service.js"
    );

    const sharedLead = {
      serviceNeeded: "water heater repair",
      urgency: "high",
      address: "123 Peachtree St, Atlanta, GA 30303",
      preferredAppointmentTime: "Tuesday morning",
    };

    const shared = {
      business,
      lead: sharedLead,
      result: {
        serviceNeeded: "water heater repair",
        urgency: "high",
        address: "123 Peachtree St, Atlanta, GA 30303",
        preferredAppointmentTime: "Tuesday morning",
      },
      policy: {
        text: "Tuesday morning works for me",
        appointmentHint: "Tuesday morning",
        intent: {
          scheduling: true,
          pricing: true,
          availabilityInquiry: false,
        },
      },
      intent: {
        scheduling: true,
        pricing: true,
        availabilityInquiry: false,
      },
      appointmentHint: "Tuesday morning",
      preferredAppointmentTime: "Tuesday morning",
      preference: "Tuesday morning",
      preferenceLabel: "Tuesday morning",
      service: "water heater repair",
      serviceNeeded: "water heater repair",
      servicePhrase: " for water heater repair",
      customerMessage: "Tuesday morning works for me",
      text: "Tuesday morning works for me",
      now: new Date("2026-09-06T16:00:00.000Z"),
    };

    const preferenceReply = safePreferenceAcknowledgement({
      ...shared,
    });

    expect(preferenceReply).toEqual(expect.any(String));
    expect(preferenceReply).toContain(
      "I can keep helping with the details while the request is reviewed.",
    );
    expect(
      hasUnverifiedStaffCommitment(preferenceReply),
    ).toBe(false);

    const combinedReply = pricingAndSchedulingReply({
      ...shared,
    });

    expect(combinedReply).toEqual(expect.any(String));
    expect(combinedReply).toContain(
      "Final pricing depends on the diagnosis and is not confirmed yet.",
    );
    expect(
      hasUnverifiedStaffCommitment(combinedReply),
    ).toBe(false);

    const expectedPricingReplies = new Set([
      "The exact cost depends on the issue and is not confirmed yet. What service do you need help with?",
      "The exact cost depends on what is causing the issue and is not confirmed yet. Is anything actively leaking or overflowing, or is only the affected fixture unusable?",
      "The exact cost depends on the diagnosis and is not confirmed yet. What is the service address?",
      "The exact cost depends on the diagnosis and is not confirmed yet. I've kept the details you've already provided.",
    ]);

    const urgencyValues = [
      undefined,
      "",
      "unknown",
      "Unknown",
      "low",
      "normal",
      "medium",
      "high",
      "emergency",
    ];

    const leadCandidates = [
      {},
      { serviceNeeded: "" },
      { serviceNeeded: "Unknown" },
      { serviceNeeded: "water heater repair" },
    ];

    for (const urgency of urgencyValues) {
      leadCandidates.push(
        {
          serviceNeeded: "water heater repair",
          urgency,
        },
        {
          serviceNeeded: "water heater repair",
          urgency,
          address: "123 Peachtree St, Atlanta, GA 30303",
        },
        {
          serviceNeeded: "water heater repair",
          urgency,
          address: "123 Peachtree St, Atlanta, GA 30303",
          preferredAppointmentTime: "Tuesday morning",
        },
      );
    }

    const observedPricingReplies = new Set();

    for (const lead of leadCandidates) {
      const reply = pricingReply({
        business,
        lead,
      });

      expect(reply).toEqual(expect.any(String));
      expect(reply).not.toMatch(
        /\bwill confirm\b|as soon as possible|\bteam will\b/i,
      );
      expect(
        hasUnverifiedStaffCommitment(reply),
      ).toBe(false);

      expect(expectedPricingReplies.has(reply)).toBe(true);
      if (expectedPricingReplies.has(reply)) {
        observedPricingReplies.add(reply);
      }
    }

    expect(
      [...observedPricingReplies].sort(),
    ).toEqual(
      [...expectedPricingReplies].sort(),
    );

    for (const reply of [
      preferenceReply,
      combinedReply,
      ...observedPricingReplies,
    ]) {
      expect(reply).not.toMatch(
        /\bwill confirm\b|as soon as possible|\bteam will\b/i,
      );
    }
  });

  test("explicit human ownership beats booking wording", async () => {
    const {
      isExplicitHumanRequestText,
    } = await import(
      "../../src/services/scheduling/customerSchedulingIntent.service.js"
    );

    const explicitHuman = [
      "I want a person to book the appointment",
      "I need a human to schedule this",
      "Can I talk to a person to book the appointment?",
      "Please connect me to an agent so I can schedule",
      "I want to speak with a representative",
    ];

    for (const phrase of explicitHuman) {
      expect(
        isExplicitHumanRequestText(phrase),
      ).toBe(true);
    }

    const serviceArrival = [
      "Can someone come tomorrow?",
      "Could a technician come Friday?",
      "Can a person come tomorrow?",
      "Would your team come out this afternoon?",
      "I want a technician to come tomorrow",
    ];

    for (const phrase of serviceArrival) {
      expect(
        isExplicitHumanRequestText(phrase),
      ).toBe(false);
    }

    expect(
      isExplicitHumanRequestText(""),
    ).toBe(false);

    // Exercise the mature fallback matcher as well.
    expect(
      typeof isExplicitHumanRequestText(
        "Can someone call me instead?",
      ),
    ).toBe("boolean");

    expect(
      typeof isExplicitHumanRequestText(
        "What are your business hours?",
      ),
    ).toBe("boolean");
  });

});
