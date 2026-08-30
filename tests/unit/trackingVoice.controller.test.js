import CallLog from "../../src/models/callLog.js";
import TrackingNumber from "../../src/models/trackingNumber.js";
import { syncLatestAttribution } from "../../src/services/marketingAttribution.service.js";
import { resolveTwilioNumberContext } from "../../src/services/twilioBusinessResolver.service.js";
import TrackingVoiceController from "../../src/controllers/trackingVoice.controller.js";
import TwilioController from "../../src/controllers/twilio.js";
import { normalizePhoneToE164 } from "../../src/voice/voicePhone.service.js";

jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/models/trackingNumber.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/services/marketingAttribution.service.js", () => ({
  __esModule: true,
  syncLatestAttribution: jest.fn(),
}));

jest.mock("../../src/services/twilioBusinessResolver.service.js", () => ({
  __esModule: true,
  resolveTwilioNumberContext: jest.fn(),
}));

jest.mock("../../src/controllers/twilio.js", () => ({
  __esModule: true,
  default: { voiceWebhook: jest.fn() },
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  __esModule: true,
  normalizePhoneToE164: jest.fn(),
}));

const makeResponse = () => {
  const res = {};
  res.type = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

const context = (overrides = {}) => ({
  business: {
    _id: "507f1f77bcf86cd799439011",
    forwardingPhone: "+14045550100",
  },
  trackingNumber: {
    _id: "507f1f77bcf86cd799439012",
    kind: "marketing",
    callHandlingMode: "forward",
    forwardingPhone: "+14045550100",
    smsRecoveryEnabled: false,
    voiceAiEnabled: false,
    ...overrides,
  },
  marketingSource: {
    _id: "507f1f77bcf86cd799439013",
  },
  attribution: {
    sourceName: "Google Ads",
    channel: "google_ads",
  },
});

const callLog = () => ({
  _id: "507f1f77bcf86cd799439014",
  trackingNumber: "507f1f77bcf86cd799439012",
  providerCallId: "CA_PARENT",
  from: "+14045550999",
  to: "+14045550123",
});

describe("TrackingVoiceController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    normalizePhoneToE164.mockImplementation(
      (value) => (value ? String(value) : ""),
    );
    CallLog.findOneAndUpdate.mockResolvedValue(
      callLog(),
    );
    CallLog.findByIdAndUpdate.mockResolvedValue(
      callLog(),
    );
    syncLatestAttribution.mockResolvedValue({});
  });

  test("forwards marketing calls to the business first", async () => {
    resolveTwilioNumberContext.mockResolvedValue(
      context(),
    );

    const req = {
      body: {
        From: "+14045550999",
        To: "+14045550123",
        CallSid: "CA_PARENT",
      },
      query: {},
    };

    const res = makeResponse();
    const next = jest.fn();

    await TrackingVoiceController.initial(
      req,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(syncLatestAttribution).toHaveBeenCalledWith(
      expect.objectContaining({
        callLogId: "507f1f77bcf86cd799439014",
      }),
    );

    const responseXml = res.send.mock.calls[0][0];
    expect(responseXml).toContain("<Dial");
    expect(responseXml).toContain(
      'answerOnBridge="true"',
    );
    expect(responseXml).toContain("+14045550100");
  });

  test("answered calls never trigger recovery", async () => {
    CallLog.findOne.mockResolvedValue(callLog());
    TrackingNumber.findById.mockResolvedValue({
      callHandlingMode: "forward",
      smsRecoveryEnabled: true,
      voiceAiEnabled: false,
    });

    const req = {
      query: { parentCallSid: "CA_PARENT" },
      body: {
        DialCallSid: "CA_CHILD",
        DialCallStatus: "completed",
      },
    };

    const res = makeResponse();
    const next = jest.fn();

    await TrackingVoiceController.complete(
      req,
      res,
      next,
    );

    expect(CallLog.findByIdAndUpdate).toHaveBeenCalledWith(
      "507f1f77bcf86cd799439014",
      {
        $set: expect.objectContaining({
          status: "answered",
          disposition: "answered_by_business",
          providerStatus: "completed",
          destinationCallSid: "CA_CHILD",
          answeredAt: expect.any(Date),
        }),
      },
    );
    expect(
      TwilioController.voiceWebhook,
    ).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test("tracking-only no-answer records outcome and stops", async () => {
    CallLog.findOne.mockResolvedValue(callLog());
    TrackingNumber.findById.mockResolvedValue({
      callHandlingMode: "forward",
      smsRecoveryEnabled: false,
      voiceAiEnabled: false,
    });

    const req = {
      query: { parentCallSid: "CA_PARENT" },
      body: {
        DialCallSid: "CA_CHILD",
        DialCallStatus: "no-answer",
      },
    };

    const res = makeResponse();
    const next = jest.fn();

    await TrackingVoiceController.complete(
      req,
      res,
      next,
    );

    expect(CallLog.findByIdAndUpdate).toHaveBeenCalledWith(
      "507f1f77bcf86cd799439014",
      {
        $set: {
          providerStatus: "no-answer",
          status: "no_answer",
          disposition: "no_answer",
          destinationCallSid: "CA_CHILD",
        },
      },
    );

    expect(
      TwilioController.voiceWebhook,
    ).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test("missed recovery restores the original caller context", async () => {
    CallLog.findOne.mockResolvedValue(callLog());
    TrackingNumber.findById.mockResolvedValue({
      callHandlingMode: "forward",
      smsRecoveryEnabled: true,
      voiceAiEnabled: false,
    });

    const req = {
      query: { parentCallSid: "CA_PARENT" },
      body: {
        DialCallSid: "CA_CHILD",
        DialCallStatus: "no-answer",
      },
    };

    const res = makeResponse();

    await TrackingVoiceController.complete(
      req,
      res,
      jest.fn(),
    );

    expect(
      TwilioController.voiceWebhook,
    ).toHaveBeenCalledTimes(1);

    expect(req.body).toMatchObject({
      CallSid: "CA_PARENT",
      From: "+14045550999",
      Caller: "+14045550999",
      To: "+14045550123",
      Called: "+14045550123",
    });
  });

  test("overflow no-answer continues to Voice AI only", async () => {
    CallLog.findOne.mockResolvedValue(callLog());
    TrackingNumber.findById.mockResolvedValue({
      callHandlingMode: "overflow",
      smsRecoveryEnabled: true,
      voiceAiEnabled: true,
    });

    const req = {
      query: { parentCallSid: "CA_PARENT" },
      body: {
        DialCallSid: "CA_CHILD",
        DialCallStatus: "no-answer",
      },
    };

    const res = makeResponse();
    const next = jest.fn();

    await TrackingVoiceController.complete(
      req,
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.query.trackingFallback).toBe("ai");
    expect(
      TwilioController.voiceWebhook,
    ).not.toHaveBeenCalled();
  });
});
