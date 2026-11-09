import { AVAILABILITY_HINT, hasBookingAvailabilityHint } from "../../src/services/booking/bookingMessagePolicy.service.js";
import { renderAppointmentResponse } from '../../src/services/scheduling/customerAppointmentPresentation.service.js';
import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("Conversation Orchestration v2 contract", () => {
  test("persists structured memory and prevents silent inbound termination", () => {
    const orchestrator = read("src/services/conversationOrchestrator.service.js");
    const conversation = read("src/models/conversation.js");
    const message = read("src/models/message.js");
    expect(orchestrator).toMatch(/silent_failure_guard/);
    expect(orchestrator).toMatch(/conversationMemory/);
    expect(conversation).toMatch(/silentFailureCount/);
    expect(message).toMatch(/aiOutcome/);
  });

  test("booking recognizes natural-language availability and negotiates alternatives", () => {
    const booking = read("src/services/booking/bookingTurnPreflight.service.js");
    const availability = read("src/services/booking/bookingAvailabilityTurn.service.js");
    // Availability intent policy is extracted from the legacy state machine.
    // Test behavior and verify the old orchestration still imports it.
    expect(booking).toMatch(/bookingMessagePolicy\.service\.js/);
    expect(AVAILABILITY_HINT.test("tomorrow afternoon")).toBe(true);
    for (const phrase of ["tomorrow afternoon", "next Friday at 3pm", "available Tuesday morning"]) {
      expect(hasBookingAvailabilityHint(phrase, "America/New_York")).toBe(true);
    }
    expect(hasBookingAvailabilityHint("not sure which service I need", "America/New_York")).toBe(false);
    expect(availability).toMatch(/scheduling_no_match_after_three_attempts/);
    expect(availability).toMatch(/renderAppointmentResponse/);
    for (const channel of ['sms', 'voice']) {
      const response = renderAppointmentResponse({kind:'offer',options:'1. Friday at 10 am; 2. Friday at 11 am',requiresApproval:true}, channel);
      expect(response).toContain('Friday at 10 am');
      expect(response).toContain('Friday at 11 am');
      expect(response).toMatch(/approval/i);
      expect(response).toMatch(channel === 'sms' ? /choose an option/i : /which works/i);
    }
  });
});
