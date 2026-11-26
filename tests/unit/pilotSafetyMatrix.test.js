import { BUSINESS_TYPES } from "../../src/helpers/businessTypes.js";
import { evaluateDeterministicInboundGuardrails } from "../../src/helpers/ai/aiGuardrails.js";
import { classifyVoiceTurn } from "../../src/voice/voiceUnderstanding.service.js";
import {
  pilotSafetyCases,
  pilotSafetyNonEmergencies,
} from "../fixtures/pilotSafetyMatrix.js";
const rows = BUSINESS_TYPES.flatMap((trade) =>
  pilotSafetyCases.map(([text, hazard]) => [trade, text, hazard]),
);
let key;
beforeAll(() => {
  key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";
});
afterAll(() => {
  process.env.OPENAI_API_KEY = key;
});
test.each(rows)(
  "B01 SMS %s handles %s deterministically",
  (trade, text, hazard) => {
    const result = evaluateDeterministicInboundGuardrails({
      customerMessage: text,
      business: { businessType: trade },
    });
    expect(result).toMatchObject({
      handled: true,
      skipAI: true,
      hazardType: hazard,
      alertPriority: "critical",
    });
    expect(result.reply).toMatch(/911|nine one one/);
  },
);
test.each(rows)(
  "B01 voice %s handles %s without a model",
  async (trade, text, hazard) => {
    const result = await classifyVoiceTurn({
      customerMessage: text,
      business: { businessType: trade },
    });
    expect(result.safety).toMatchObject({
      isEmergency: true,
      hazardType: hazard,
    });
    expect(result.safety.reply).toMatch(/911|nine one one/);
  },
);
test.each(pilotSafetyNonEmergencies)(
  "B01 negated or resolved hazard remains non-emergency: %s",
  (text) => {
    expect(
      evaluateDeterministicInboundGuardrails({ customerMessage: text })
        .hazardType || "",
    ).toBe("");
  },
);
