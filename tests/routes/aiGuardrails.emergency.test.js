import {
  evaluateDeterministicInboundGuardrails,
  detectSafetyHazardType,
  containsSafetyHazard,
  getEmergencyReply,
  SAFETY_HAZARD_TYPES,
  SAFE_REPLIES,
} from "../../src/helpers/ai/aiGuardrails.js";

/*
 * Every entry: [customer message, expected hazard type].
 * Each must produce a critical alert_owner decision with the reply that
 * matches its hazard type — never the generic business fallback.
 */
const EMERGENCY_CASES = [
  // Flooding (original bug report cases)
  ["I'm scared. I think it may flood my house.", "flood"],
  ["I'm scared i think it may flood my house", "flood"],
  ["The leak might flood our basement.", "flood"],
  ["The water is spreading across the floor.", "flood"],
  ["The water will not stop.", "flood"],
  ["I am worried the house is going to flood.", "flood"],
  ["Water is pouring through the ceiling", "flood"],
  ["There's water everywhere", "flood"],
  ["A pipe burst and my kitchen is flooding", "flood"],
  ["active flooding in the basement right now", "flood"],

  // Medical
  ["My husband fell off the ladder and he's not breathing", "medical"],
  ["Someone passed out in the basement", "medical"],
  ["My son is bleeding badly", "medical"],
  ["He got hurt working on the panel", "medical"],
  ["She's having chest pain, what do we do", "medical"],
  ["We called an ambulance", "medical"],
  ["The technician was injured", "medical"],
  ["My wife burned herself on the water heater", "medical"],

  // Gas / CO
  ["I smell gas in my kitchen", "gas"],
  ["It smells like rotten eggs near the furnace", "gas"],
  ["There's a hissing sound coming from the gas line", "gas"],
  ["I think the water heater might explode", "gas"],
  ["carbon monoxide alarm going off", "gas"],
  ["propane leak in the garage", "gas"],

  // Fire
  ["There's smoke coming from the furnace", "fire"],
  ["I smell something burning in the walls", "fire"],
  ["There was an explosion in the garage", "fire"],

  // Electrical
  ["The outlet is sparking", "electrical"],
  ["There's a downed power line in my yard", "electrical"],
  ["The breaker panel is smoking", "electrical"],
  ["My kid got shocked by the outlet", "electrical"],
  ["There are exposed wires hanging from the ceiling fan", "electrical"],
  ["Water is leaking into the electrical panel", "electrical"],

  // Structural
  ["The ceiling is collapsing in the kitchen", "structural"],
  ["A tree fell through my roof", "structural"],
  ["The bathroom ceiling caved in", "structural"],
  ["The wall is giving way", "structural"],

  // Trapped
  ["My dog is trapped under the deck", "trapped"],
  ["My child is locked in the bathroom and I can't get in", "trapped"],
  ["Someone is trapped in the crawl space", "trapped"],

  // Sewage
  ["There's a sewage backup in my basement", "sewage"],

  // Temperature (vulnerable occupants)
  [
    "We have no heat and my newborn is in the house and it's freezing",
    "temperature",
  ],
  [
    "It's a heat wave and we have no AC, my elderly mother lives with us",
    "temperature",
  ],

  // Generic distress
  ["This is an emergency", "other"],
  ["Should I call 911?", "other"],
  ["We are in danger, please hurry", "other"],
  ["It's life threatening", "other"],
];

/*
 * Normal service inquiries that use hazard-adjacent words but must NOT
 * trigger the emergency guardrail (false-positive traps).
 */
const NON_EMERGENCY_MESSAGES = [
  "My kitchen faucet is leaking a little, can I get a quote?",
  "Can you install a flood light in my backyard?",
  "I'd like to schedule a water heater replacement next week.",
  "How much do you charge for a drain cleaning?",
  "Do you service the 30318 zip code?",
  "Do you offer emergency plumbing services?",
  "I'm stuck in traffic, running late for our appointment",
  "Can you bleed the radiator when you come out?",
  "There's air trapped in the pipes and they're knocking",
  "My deck is falling apart, can I get a repair quote?",
  "My address is 911 Main Street",
  "Can you help us pick a new AC unit?",
];

describe("AI Safety Guardrails", () => {
  describe("emergency detection", () => {
    test.each(EMERGENCY_CASES)(
      "%j is treated as a critical %s emergency",
      (message, expectedType) => {
        const result = evaluateDeterministicInboundGuardrails({
          customerMessage: message,
        });

        expect(result.category).toBe("emergency");
        expect(result.decision).toBe("alert_owner");
        expect(result.shouldAlertOwner).toBe(true);
        expect(result.alertPriority).toBe("critical");
        expect(result.riskFlags).toEqual(["safety_hazard"]);
        expect(result.skipAI).toBe(true);
        expect(result.hazardType).toBe(expectedType);
        expect(result.reply).toBe(getEmergencyReply(expectedType));
        expect(result.reply).not.toBe(SAFE_REPLIES.fallback);
      },
    );
  });

  describe("false positives", () => {
    test.each(NON_EMERGENCY_MESSAGES)(
      "%j is NOT treated as an emergency",
      (message) => {
        expect(detectSafetyHazardType(message)).toBe("");

        const result = evaluateDeterministicInboundGuardrails({
          customerMessage: message,
        });

        expect(result.category).not.toBe("emergency");
      },
    );
  });

  describe("hazard severity ordering", () => {
    test("medical outranks other hazards when a person is down", () => {
      expect(detectSafetyHazardType("I smell gas and my wife passed out")).toBe(
        "medical",
      );

      expect(
        detectSafetyHazardType(
          "The basement is flooding and my dad is unconscious",
        ),
      ).toBe("medical");
    });

    test("gas outranks flood when a message mentions both", () => {
      expect(
        detectSafetyHazardType(
          "There's a gas leak and the basement is flooding",
        ),
      ).toBe("gas");
    });
  });

  describe("message parsing", () => {
    test("multi-line messages still match", () => {
      expect(
        detectSafetyHazardType("I'm scared.\nI think it may flood\nmy house."),
      ).toBe("flood");

      expect(
        detectSafetyHazardType("Please hurry.\nThe ceiling\nis collapsing."),
      ).toBe("structural");
    });
  });

  describe("emergency precedence over other guardrails", () => {
    test("emergencies are never suppressed by spam/rate limiting", () => {
      const now = Date.now();

      /*
       * Simulate a customer who has already sent many rapid messages, which
       * would normally trip the inbound rate limit.
       */
      const recentMessages = Array.from({ length: 20 }, (_, index) => ({
        direction: "inbound",
        body: `message ${index}`,
        createdAt: new Date(now - index * 1000),
      }));

      const result = evaluateDeterministicInboundGuardrails({
        customerMessage: "The water won't stop and it's flooding my house!",
        recentMessages,
      });

      expect(result.category).toBe("emergency");
      expect(result.reply).toBe(SAFE_REPLIES.floodEmergency);
      expect(result.shouldAlertOwner).toBe(true);
    });
  });

  describe("safe replies", () => {
    test("containsSafetyHazard stays backward compatible", () => {
      expect(containsSafetyHazard("carbon monoxide alarm going off")).toBe(
        true,
      );
      expect(containsSafetyHazard("sewage backup in the basement")).toBe(true);
      expect(containsSafetyHazard("please give me a quote")).toBe(false);
    });

    test.each(SAFETY_HAZARD_TYPES)(
      "%s has a mapped reply that directs the customer to 911",
      (hazardType) => {
        const reply = getEmergencyReply(hazardType);

        expect(reply).toBeTruthy();
        expect(reply).toMatch(/911/);
      },
    );

    test("unknown hazard types fall back to the generic emergency reply", () => {
      expect(getEmergencyReply("unknown_type")).toBe(SAFE_REPLIES.emergency);
      expect(getEmergencyReply("")).toBe(SAFE_REPLIES.emergency);
    });

    test.each(SAFETY_HAZARD_TYPES)(
      "%s reply fits within the SMS length limit",
      (hazardType) => {
        expect(getEmergencyReply(hazardType).length).toBeLessThanOrEqual(320);
      },
    );
  });
});
