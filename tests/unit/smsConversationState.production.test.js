import { deriveSmsConversationPhase } from "../../src/services/messaging/smsConversationState.service.js";

describe("SMS conversation state authority", () => {
  test.each([
    ["collecting_service", "qualifying"],
    ["collecting_location", "collecting_location"],
    ["collecting_postal_code", "collecting_location"],
    ["collecting_preference", "scheduling"],
    ["offering_slots", "scheduling"],
    ["awaiting_confirmation", "awaiting_customer_confirmation"],
    ["pending_business_confirmation", "awaiting_business_approval"],
    ["booked", "confirmed"],
  ])("%s maps to %s", (bookingStatus, phase) => {
    expect(deriveSmsConversationPhase({ status: "open", humanTakeover: false, bookingState: { status: bookingStatus } })).toBe(phase);
  });

  test("human takeover is authoritative over booking", () => {
    expect(deriveSmsConversationPhase({ status: "open", humanTakeover: true, bookingState: { status: "offering_slots" } })).toBe("human_takeover");
  });

  test("closed conversation cannot be reopened by derived state", () => {
    expect(deriveSmsConversationPhase({ status: "closed" })).toBe("closed");
  });
});
