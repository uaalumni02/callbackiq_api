import {
  hasUnverifiedStaffCommitment,
  sanitizeUnverifiedStaffCommitments,
} from "../../src/services/customerCommitmentSafety.service.js";

describe("customer commitment safety parity", () => {
  test.each([
    "The team will contact you shortly.",
    "A team member will follow up as soon as possible.",
    "Someone will call you soon.",
    "Expect a callback shortly.",
    "I've asked Atlanta Pro Plumbing to call the number you're texting from.",
    "Atlanta Pro Plumbing will confirm availability as soon as possible.",
    "The team will confirm the update directly.",
    "Pricing will be confirmed after assessment.",
  ])("detects unverified English staff promises: %s", (text) => {
    expect(hasUnverifiedStaffCommitment(text)).toBe(true);
  });

  test("removes a callback-time promise without discarding the rest of the SMS", () => {
    const result = sanitizeUnverifiedStaffCommitments(
      "I saved your water-heater leak details. The team will contact you shortly. What is the service address?",
      { channel: "sms" },
    );

    expect(result).toMatch(/saved your water-heater leak details/i);
    expect(result).toMatch(/can't guarantee when someone will be available/i);
    expect(result).toMatch(/what is the service address/i);
    expect(hasUnverifiedStaffCommitment(result)).toBe(false);
  });

  test("removes future confirmation promises while preserving useful context", () => {
    const result = sanitizeUnverifiedStaffCommitments(
      "I saved Tuesday morning as your preference. The team will confirm availability as soon as possible.",
      { channel: "sms" },
    );

    expect(result).toMatch(/saved Tuesday morning/i);
    expect(result).toMatch(/can't guarantee when someone will be available/i);
    expect(hasUnverifiedStaffCommitment(result)).toBe(false);
  });

  test("uses a voice-appropriate safe replacement", () => {
    const result = sanitizeUnverifiedStaffCommitments(
      "Someone will call you soon.",
      { channel: "voice" },
    );

    expect(result).toMatch(/on this call/i);
    expect(hasUnverifiedStaffCommitment(result)).toBe(false);
  });

  test("sanitizes Spanish callback promises", () => {
    const result = sanitizeUnverifiedStaffCommitments(
      "El equipo se comunicará al número confirmado.",
      { channel: "voice" },
    );

    expect(result).toMatch(/no puedo garantizar/i);
    expect(hasUnverifiedStaffCommitment(result)).toBe(false);
  });

  test("does not alter authoritative appointment confirmation language", () => {
    const original = "Your appointment is confirmed for Monday at 10:00 AM.";
    expect(
      sanitizeUnverifiedStaffCommitments(original, { channel: "voice" }),
    ).toBe(original);
  });
});
