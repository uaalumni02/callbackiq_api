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
