const mockInbound = jest.fn();
const mockManual = jest.fn();
const mockVoice = jest.fn();
const mockStatus = jest.fn();

jest.mock("../../src/services/twilioSmsWebhook.service.js", () => ({
  handleInboundSmsWebhook: (...args) => mockInbound(...args),
  handleManualSmsRequest: (...args) => mockManual(...args),
  handleSmsRecoveryVoiceWebhook: (...args) => mockVoice(...args),
  handleTwilioStatusWebhook: (...args) => mockStatus(...args),
}));

const TwilioController = require("../../src/controllers/twilio.js").default;

describe("TwilioController public ingress delegation", () => {
  const req = { body: { MessageSid: "SM123" } };
  const res = { status: jest.fn(), send: jest.fn(), json: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  test.each([
    ["voiceWebhook", mockVoice, { kind: "voice" }],
    ["statusWebhook", mockStatus, { kind: "status" }],
    ["handleInboundSms", mockInbound, { kind: "inbound" }],
    ["sendManualSms", mockManual, { kind: "manual" }],
  ])("%s delegates request/response and returns service result", async (method, target, value) => {
    target.mockResolvedValue(value);
    await expect(TwilioController[method](req, res)).resolves.toBe(value);
    expect(target).toHaveBeenCalledTimes(1);
    expect(target).toHaveBeenCalledWith(req, res);
  });

  test.each([
    ["voiceWebhook", mockVoice],
    ["statusWebhook", mockStatus],
    ["handleInboundSms", mockInbound],
    ["sendManualSms", mockManual],
  ])("%s does not swallow provider/service failures", async (method, target) => {
    target.mockRejectedValue(new Error(`${method} failed`));
    await expect(TwilioController[method](req, res)).rejects.toThrow(
      `${method} failed`,
    );
  });
});
