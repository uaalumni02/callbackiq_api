import fs from "node:fs";
import path from "node:path";
import { business, conversation, messages, normalizationCases } from "../fixtures/conversationIntelligence/normalizationCases.js";

let mockCase;
let mockTrace;
let mockRequest;
const mockCopy = value => JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? { undefined: true } : item));
const mockApplyEnv = values => { for (const [key, value] of Object.entries(values || {})) process.env[key] = value; };

jest.mock("../../src/integrations/providerClients.js", () => ({
  createOpenAIClient: (purpose, options) => {
    mockTrace.push({ fn: "createOpenAIClient", args: mockCopy([purpose, options]) });
    return { responses: { create: async request => {
      mockTrace.push({ fn: "responses.create" }); mockRequest = request;
      mockApplyEnv(mockCase.providerEnv);
      if (mockCase.errorMode === "provider-error") throw Object.assign(new TypeError("provider unavailable"), { code: "PROVIDER_FAILURE" });
      if (mockCase.errorMode === "empty-output") return { id: "response-ci", output_text: "  " };
      if (mockCase.errorMode === "invalid-json") return { id: "response-ci", output_text: "not json" };
      if (mockCase.errorMode === "non-string-output") return { id: "response-ci", output_text: 42 };
      const analysis = mockCopy(mockCase.analysis);
      if (mockCase.errorMode === "blank-summary") analysis.summary = " ";
      return { id: "response-ci", output_text: JSON.stringify(analysis) };
    } } };
  },
}));

jest.mock("../../src/models/serviceOffering.js", () => ({ __esModule: true, default: {
  find: filter => {
    mockTrace.push({ fn: "ServiceOffering.find", args: mockCopy([filter]) });
    return { lean: async () => {
      if (mockCase.errorMode === "database-error") throw Object.assign(new Error("database unavailable"), { code: "DB_FAILURE" });
      return [{ _id: "service-ci", business: "business-ci", active: true, name: "Sink repair",
        category: "plumbing", keywords: ["sink"], estimatedValue: 225 }];
    } };
  },
} }));

jest.mock("../../src/helpers/ai/aiGuardrails.js", () => {
  const actual = jest.requireActual("../../src/helpers/ai/aiGuardrails.js");
  const wrap = name => (...args) => {
    const record = { fn: name, args: mockCopy(args) }; mockTrace.push(record);
    if (name === "sanitizeOutboundReply") {
      mockApplyEnv(mockCase.guardrailEnv);
      if (mockCase.errorMode === "guardrail-error") throw Object.assign(new Error("guardrail unavailable"), { code: "GUARDRAIL_FAILURE" });
      if (mockCase.errorMode === "guardrail-invalid-result") return { reply: "Fallback", usedFallback: true };
    }
    const result = name === "sanitizeOutboundReply" && mockCase.guardrailResult
      ? mockCopy(mockCase.guardrailResult) : actual[name](...args);
    record.result = mockCopy(result);
    return result;
  };
  return { ...actual, buildBusinessCapabilities: wrap("buildBusinessCapabilities"),
    buildVerifiedBusinessFacts: wrap("buildVerifiedBusinessFacts"),
    redactSensitiveData: wrap("redactSensitiveData"), sanitizeOutboundReply: wrap("sanitizeOutboundReply") };
});

jest.mock("../../src/services/valuation/opportunityValue.js", () => {
  const actual = jest.requireActual("../../src/services/valuation/opportunityValue.js");
  return { ...actual, resolveOpportunityValue: args => {
    mockTrace.push({ fn: "resolveOpportunityValue", args: mockCopy([args]) });
    if (mockCase.errorMode === "valuation-error") throw Object.assign(new Error("valuation unavailable"), { code: "VALUATION_FAILURE" });
    return actual.resolveOpportunityValue(args);
  } };
});

const directory = path.resolve("tests/fixtures/conversationIntelligence");
const expected = JSON.parse(fs.readFileSync(path.join(directory, "characterization.json"), "utf8"));
const environmentNames = ["OPENAI_API_KEY", "OPENAI_CONVERSATION_MODEL", "OPENAI_MODEL",
  "CONVERSATION_INTELLIGENCE_MAX_MESSAGES", "CONVERSATION_INTELLIGENCE_MAX_CHARACTERS"];
let originalEnvironment;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(environmentNames.map(key => [key, process.env[key]]));
  environmentNames.forEach(key => delete process.env[key]);
  process.env.OPENAI_API_KEY = "test-openai-key";
  mockTrace = []; mockRequest = undefined;
  jest.spyOn(console, "error").mockImplementation((...args) => mockTrace.push({ fn: "console.error", args: mockCopy(args) }));
});
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  jest.restoreAllMocks();
});

test.each(normalizationCases())("preserves provider request, normalization, guardrail calls and errors: $name", async fixture => {
  mockCase = fixture; mockApplyEnv(fixture.moduleEnv); mockApplyEnv(fixture.env);
  let exports;
  jest.isolateModules(() => { exports = require("../../src/services/conversationIntelligence.service.js"); });
  mockApplyEnv(fixture.afterLoadEnv);
  expect(Object.keys(exports).filter(key => key !== "__esModule")).toEqual(["default"]);
  const input = { business: mockCopy(business), conversation: mockCopy(conversation), lead: null, messages: mockCopy(messages) };
  if (fixture.longTranscript) input.messages = Array.from({ length: 15 }, (_, i) => ({ direction: "inbound",
    body: `Message ${i} ${"x".repeat(1100)}`, createdAt: `2026-11-01T10:${String(i).padStart(2, "0")}:00.000Z` }));
  const mode = fixture.errorMode;
  if (mode === "missing-key") delete process.env.OPENAI_API_KEY;
  if (mode === "missing-business") input.business = null;
  if (mode === "missing-conversation") input.conversation = null;
  if (mode === "missing-messages") input.messages = [];
  if (mode === "empty-transcript") input.messages = [{ body: " " }];
  if (mode === "invalid-date") input.messages[0].createdAt = "invalid";
  let output, error;
  const pending = exports.default.analyze(input);
  expect(pending).toBeInstanceOf(Promise);
  try { output = await pending; } catch (err) { error = { type: err.constructor.name, message: err.message, code: err.code }; }
  const actual = mockCopy({ output, error, trace: mockTrace, requestJson: mockRequest ? JSON.stringify(mockRequest) : undefined });
  expect(actual).toEqual(expected[fixture.name]);
  if (fixture.name === "happy") {
      expect(mockRequest.text.format.schema).toEqual(JSON.parse(fs.readFileSync(path.join(directory, "provider-schema.json"), "utf8")));
      expect(JSON.stringify(mockRequest)).toBe(fs.readFileSync(path.join(directory, "provider-request.json"), "utf8"));
  }
});
