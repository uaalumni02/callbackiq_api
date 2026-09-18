const original = process.env.OPENAI_API_KEY;
beforeEach(() => { delete process.env.OPENAI_API_KEY; });
afterAll(() => { if (original) process.env.OPENAI_API_KEY = original; });

test("profanity about a broken system is not directed abuse", async () => {
  const { classifyVoiceTurn } = await import("../../src/voice/voiceUnderstanding.service.js");
  const result = await classifyVoiceTurn({ customerMessage: "The damn water heater is shit and leaking everywhere" });
  expect(result.directedAbuse).toBe(false);
  expect(result.situationProfanity).toBe(true);
});

test("directed abuse is distinguished from situation profanity", async () => {
  const { classifyVoiceTurn } = await import("../../src/voice/voiceUnderstanding.service.js");
  const result = await classifyVoiceTurn({ customerMessage: "Your company is a scam and you are an idiot" });
  expect(result.directedAbuse).toBe(true);
});

test("detects Spanish and extracts a ZIP deterministically", async () => {
  const { classifyVoiceTurn } = await import("../../src/voice/voiceUnderstanding.service.js");
  const result = await classifyVoiceTurn({ customerMessage: "Hola necesito un plomero en 30318 por favor" });
  expect(result.language).toBe("es");
  expect(result.entities.postalCode).toBe("30318");
});


test.each([
  "My bathtub needs resealing. How much is the cost",
  "Bathtub needs resealing",
  "Seal around tub needs to be replaced",
])("captures service evidence without requiring exact booking keywords: %s", async customerMessage => {
  const { classifyVoiceTurn } = await import("../../src/voice/voiceUnderstanding.service.js");
  const result = await classifyVoiceTurn({ customerMessage });
  expect(result.intent).not.toBe("unknown");
  expect(result.entities.service).toMatch(/seal|tub/i);
});

test("an invalid or low confidence model result preserves deterministic service evidence", async () => {
  const { classifyVoiceTurn, validateVoiceVerdict } = await import("../../src/voice/voiceUnderstanding.service.js");
  const fallback = await classifyVoiceTurn({ customerMessage: "My bathtub needs resealing" });
  expect(validateVoiceVerdict({}, fallback)).toEqual(fallback);
  expect(validateVoiceVerdict({ ...fallback, confidence: 12, intent: "unknown" }, fallback)).toEqual(fallback);
});


test("a confident unknown model verdict cannot erase a directly stated service", async () => {
  const { classifyVoiceTurn, validateVoiceVerdict } = await import("../../src/voice/voiceUnderstanding.service.js");
  const fallback = await classifyVoiceTurn({ customerMessage: "My bathtub needs resealing" });
  const result = validateVoiceVerdict({ ...fallback, confidence: 90, intent: "unknown", entities: { ...fallback.entities, service: "" } }, fallback);
  expect(result.intent).toBe("service_request");
  expect(result.entities.service).toBe(fallback.entities.service);
});

test.each(['The water is now spilling out to the floor', 'Water is running onto the carpet'])('voice takes the deterministic safety path: %s', async customerMessage => {
  const { classifyVoiceTurn } = await import('../../src/voice/voiceUnderstanding.service.js');
  const result = await classifyVoiceTurn({ customerMessage });
  expect(result.safety).toMatchObject({ isEmergency: true, hazardType: 'flood' });
  expect(result.source).toBe('deterministic');
});
