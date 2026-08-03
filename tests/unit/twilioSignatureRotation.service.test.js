import twilio from "twilio";
import {
  validateTwilioRequestWithRotation,
  getTwilioRotationState,
} from "../../src/services/twilioSignatureRotation.service.js";

jest.mock("twilio", () => ({
  __esModule: true,
  default: { validateRequest: jest.fn() },
}));

describe("Twilio signature rotation", () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original };
    jest.clearAllMocks();
  });
  afterAll(() => {
    process.env = original;
  });

  test("accepts either primary or next token", () => {
    process.env.TWILIO_AUTH_TOKEN = "primary";
    process.env.TWILIO_AUTH_TOKEN_NEXT = "next";
    twilio.validateRequest
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    expect(
      validateTwilioRequestWithRotation({
        signature: "sig",
        url: "https://example.com/webhook",
        params: {},
      }),
    ).toBe(true);
    expect(twilio.validateRequest).toHaveBeenNthCalledWith(
      2,
      "next",
      "sig",
      "https://example.com/webhook",
      {},
    );
  });

  test("reports rotation readiness without exposing secrets", () => {
    process.env.TWILIO_AUTH_TOKEN = "primary";
    process.env.TWILIO_AUTH_TOKEN_NEXT = "next";
    expect(getTwilioRotationState()).toEqual({
      primaryConfigured: true,
      nextConfigured: true,
      previousConfigured: false,
      acceptedTokenCount: 2,
    });
  });
});
