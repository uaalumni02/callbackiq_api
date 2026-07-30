jest.mock("../../src/models/voiceCapacity.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: jest.fn(),
  },
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalEvent: jest.fn(),
  logOperationalWarning: jest.fn(),
  logOperationalError: jest.fn(),
}));

import VoiceCapacity from "../../src/models/voiceCapacity.js";
import AlertService from "../../src/services/alert.service.js";
import {
  acquireVoiceCapacity,
  releaseVoiceCapacity,
} from "../../src/services/voiceCapacity.service.js";

describe("voice connection capacity", () => {
  const business = {
    _id: "64f000000000000000000001",
    voiceSettings: {
      maxConcurrentCalls: 5,
      maxCallDurationSeconds: 900,
    },
  };
  const session = {
    _id: "64f000000000000000000002",
    providerCallSid: "CA123",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    AlertService.createSystemAlert.mockResolvedValue({ _id: "alert-1" });
    VoiceCapacity.updateOne.mockResolvedValue({ acknowledged: true });
  });

  test("reserves a call and warns when capacity is at least 80 percent", async () => {
    VoiceCapacity.findOneAndUpdate.mockResolvedValue({
      leases: [
        { key: "CA1" },
        { key: "CA2" },
        { key: "CA3" },
        { key: "CA123" },
      ],
    });

    const result = await acquireVoiceCapacity({ business, session });

    expect(result).toMatchObject({
      allowed: true,
      maximum: 5,
      activeCount: 4,
      durationSeconds: 900,
    });
    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Voice AI capacity is nearly full",
        priority: "medium",
      }),
    );
  });

  test("denies a call when no capacity lease was added", async () => {
    VoiceCapacity.findOneAndUpdate.mockResolvedValue({
      leases: [
        { key: "CA1" },
        { key: "CA2" },
        { key: "CA3" },
        { key: "CA4" },
        { key: "CA5" },
      ],
    });

    const result = await acquireVoiceCapacity({ business, session });

    expect(result).toMatchObject({
      allowed: false,
      reason: "voice_concurrency_limit",
      activeCount: 5,
    });
    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Voice AI concurrency allowance reached",
        priority: "high",
      }),
    );
  });

  test("releases the lease when the WebSocket session ends", async () => {
    await releaseVoiceCapacity({ businessId: business._id, session });

    expect(VoiceCapacity.updateOne).toHaveBeenCalledWith(
      { business: business._id },
      { $pull: { leases: { key: "CA123" } } },
    );
  });
});
