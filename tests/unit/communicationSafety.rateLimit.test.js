jest.mock("../../src/models/communicationRouteRateLimit.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalEvent: jest.fn(),
  logOperationalWarning: jest.fn(),
  logOperationalError: jest.fn(),
}));

import CommunicationRouteRateLimit from "../../src/models/communicationRouteRateLimit.js";
import {
  createCommunicationRouteRateLimit,
  resetCommunicationRouteRateLimits,
} from "../../src/middleware/twilio-webhook-rate-limit.js";

const makeResponse = () => {
  const res = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn(() => res);
  res.type = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("communication route rate limiting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCommunicationRouteRateLimits();
    CommunicationRouteRateLimit.findOneAndUpdate.mockResolvedValue({
      _id: "counter",
      count: 1,
    });
  });

  test("throttles repeated valid requests by route identity", async () => {
    const middleware = createCommunicationRouteRateLimit({
      name: "test-manual",
      max: 2,
      windowMs: 60_000,
      keyBuilder: (req) => [req.user.userId, req.body.to],
    });
    const req = {
      ip: "127.0.0.1",
      path: "/send-sms",
      user: { userId: "owner-1" },
      body: { to: "+14045550101" },
    };
    const next = jest.fn();

    await middleware(req, makeResponse(), next);
    await middleware(req, makeResponse(), next);
    const blockedResponse = makeResponse();
    await middleware(req, blockedResponse, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(blockedResponse.status).toHaveBeenCalledWith(429);
    expect(blockedResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  test("honors the distributed counter across application instances", async () => {
    CommunicationRouteRateLimit.findOneAndUpdate.mockResolvedValue(null);
    const middleware = createCommunicationRouteRateLimit({
      name: "test-twilio",
      max: 10,
      windowMs: 60_000,
      twiml: true,
      keyBuilder: (req) => [req.body.From, req.body.To],
    });
    const req = {
      ip: "127.0.0.1",
      path: "/sms",
      body: { From: "+14045550101", To: "+14045550100" },
    };
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.type).toHaveBeenCalledWith("text/xml");
  });
});
