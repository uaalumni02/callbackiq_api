import {
  classifyOperationalUrgency,
  isAvailabilityInquiryText,
  isExplicitHumanRequestText,
} from "../../src/services/scheduling/customerSchedulingIntent.service.js";
import { classifySmsIntent } from "../../src/services/messaging/smsIntentClassifier.service.js";
import {
  isBookingIntent,
  isHumanRequest,
  isVoiceAvailabilityInquiry,
} from "../../src/voice/voiceInput.service.js";

describe("shared SMS + voice production scheduling language", () => {
  const availabilityPhrases = [
    // Plumbing
    "when could someone come out?",
    "Tomorrow at 9am are you available for the service?",
    "What is you availability this week?",
    "can someone come tomorrow at 9?",
    "can you come tomorrow at 9?",
    "how soon can a plumber get here?",
    "do you have anybody free today?",
    "what is your earliest opening for a drain call?",
    // HVAC
    "how quickly could a tech come look at my AC?",
    "can you fit me in tomorrow for the furnace?",
    "what time can the technician get here?",
    // Electrical
    "when can an electrician come out?",
    "any openings this afternoon for an electrical issue?",
    // Roofing / restoration
    "what does your schedule look like for a roof inspection?",
    "how soon can your team visit for water damage?",
    "got anything tomorrow for storm damage?",
    // Garage door / locksmith
    "can I get someone out here today for my garage door?",
    "when could a locksmith be here?",
    "anybody available tonight for a lockout?",
    // Landscaping
    "what is the soonest appointment for tree cleanup?",
    "are you available Friday for landscaping?",
    // Generic natural language
    "when can someone come?",
    "when could somebody come out?",
    "how soon could you send somebody?",
    "what's the soonest you can come?",
    "do you have anything today?",
    "anybody available this afternoon?",
    "can somebody come today?",
    "when's the earliest appointment?",
    "do you have anybody free?",
    "how quickly can someone come out?",
    "what availability do you have this week?",
    "which slots are open tomorrow?",
  ];

  test.each(availabilityPhrases)("routes availability phrase to the calendar: %s", (phrase) => {
    expect(isAvailabilityInquiryText(phrase)).toBe(true);
    expect(isVoiceAvailabilityInquiry(phrase)).toBe(true);
    expect(isBookingIntent(phrase)).toBe(true);
    expect(isHumanRequest(phrase)).toBe(false);

    const sms = classifySmsIntent({ customerMessage: phrase });
    expect(sms.intents.availabilityInquiry).toBe(true);
    expect(sms.intents.scheduling).toBe(true);
    expect(sms.intents.human).toBe(false);
  });

  test.each([
    "I'm available Friday morning",
    "Tuesday at 2 works for me",
    "Tomorrow afternoon is best for me",
    "We are available after 5",
    "I prefer Monday",
  ])("does not confuse a customer preference with an availability inquiry: %s", (phrase) => {
    expect(isAvailabilityInquiryText(phrase)).toBe(false);
  });

  test.each([
    "please transfer me to a person",
    "I need to speak with a representative",
    "can the team call me back?",
    "get me a human",
    "connect me with the dispatcher",
  ])("preserves explicit human requests: %s", (phrase) => {
    expect(isExplicitHumanRequestText(phrase)).toBe(true);
    expect(isHumanRequest(phrase)).toBe(true);
  });

  test("preserves the exact high-urgency plumbing conversation independently of scheduling", () => {
    expect(
      classifyOperationalUrgency(
        "The bathroom sink is actively leaking on the floor and I have loss of service",
      ),
    ).toBe("high");

    const schedulingTurn = classifySmsIntent({
      customerMessage: "when could someone come out?",
    });
    expect(schedulingTurn.intents.availabilityInquiry).toBe(true);
    expect(schedulingTurn.entities.urgency).toBe("");
  });

  test.each([
    "I smell gas near the furnace",
    "there is smoke and sparking at the panel",
    "a pipe burst and water is gushing everywhere",
  ])("classifies emergency operational language: %s", (phrase) => {
    expect(classifyOperationalUrgency(phrase)).toBe("emergency");
  });

  test.each([
    "the roof is actively leaking",
    "we have no heat",
    "the garage door is stuck open and won't close",
    "I'm locked out",
    "there is a sewage backup",
  ])("classifies high operational urgency across service verticals: %s", (phrase) => {
    expect(classifyOperationalUrgency(phrase)).toBe("high");
  });
});
