jest.mock("../../src/services/twilioSmsWebhook.service.js", () => ({
  __esModule: true,
  handleSmsRecoveryVoiceWebhook: jest.fn(),
  handleTwilioStatusWebhook: jest.fn(),
  handleInboundSmsWebhook: jest.fn(),
  handleManualSmsRequest: jest.fn(),
}));

import * as TwilioWebhookService from "../../src/services/twilioSmsWebhook.service.js";
import TwilioController from "../../src/controllers/twilio.js";

const cases = [
  [
    "voiceWebhook",
    "handleSmsRecoveryVoiceWebhook",
    { body: { CallSid: "CA_COVERAGE" } },
  ],
  [
    "statusWebhook",
    "handleTwilioStatusWebhook",
    { body: { MessageSid: "SM_STATUS_COVERAGE" } },
  ],
  [
    "handleInboundSms",
    "handleInboundSmsWebhook",
    {
      body: {
        From: "+14045550100",
        To: "+14045550200",
        Body: "I need plumbing service",
        MessageSid: "SM_INBOUND_COVERAGE",
      },
    },
  ],
  [
    "sendManualSms",
    "handleManualSmsRequest",
    {
      user: { userId: "owner-1" },
      body: {
        to: "+14045550100",
        from: "+14045550200",
        body: "Hello",
      },
    },
  ],
];

describe("TwilioController final direct coverage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(cases)(
    "%s delegates successful requests to %s",
    async (controllerMethod, serviceMethod, req) => {
      const res = { marker: `${controllerMethod}-response` };
      const expected = {
        ok: true,
        controllerMethod,
      };

      TwilioWebhookService[serviceMethod].mockResolvedValue(expected);

      await expect(
        TwilioController[controllerMethod](req, res),
      ).resolves.toBe(expected);

      expect(
        TwilioWebhookService[serviceMethod],
      ).toHaveBeenCalledTimes(1);

      expect(
        TwilioWebhookService[serviceMethod],
      ).toHaveBeenCalledWith(req, res);
    },
  );

  test.each(cases)(
    "%s propagates delegated failures from %s",
    async (controllerMethod, serviceMethod, req) => {
      const res = { marker: `${controllerMethod}-error-response` };
      const error = new Error(
        `${controllerMethod} delegated coverage failure`,
      );

      TwilioWebhookService[serviceMethod].mockRejectedValue(error);

      await expect(
        TwilioController[controllerMethod](req, res),
      ).rejects.toBe(error);

      expect(
        TwilioWebhookService[serviceMethod],
      ).toHaveBeenCalledTimes(1);

      expect(
        TwilioWebhookService[serviceMethod],
      ).toHaveBeenCalledWith(req, res);
    },
  );
});
