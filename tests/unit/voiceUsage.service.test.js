import VoiceUsageLedger from "../../src/models/voiceUsageLedger.js";
import AlertService from "../../src/services/alert.service.js";
import {
  reserveVoiceUsage,
} from "../../src/services/voiceUsage.service.js";

jest.mock("../../src/models/voiceUsageLedger.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
  },
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createSystemAlert: jest.fn() },
}));

describe("voice usage hard caps", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rejects a call that would exceed a daily hard cap", async () => {
    const daily = {
      _id: "day",
      periodType: "day",
      periodKey: "2026-08-03",
      completedSeconds: 3590,
      reservedSeconds: 0,
      thresholdAlertsSent: [],
      save: jest.fn(),
    };
    const monthly = {
      _id: "month",
      periodType: "month",
      periodKey: "2026-08",
      completedSeconds: 3590,
      reservedSeconds: 0,
      thresholdAlertsSent: [],
      save: jest.fn(),
    };
    VoiceUsageLedger.findOneAndUpdate
      .mockResolvedValueOnce(daily)
      .mockResolvedValueOnce(monthly);

    const result = await reserveVoiceUsage({
      business: {
        _id: "business-1",
        voiceSettings: {
          dailyVoiceMinutes: 60,
          monthlyVoiceMinutes: 1000,
          voiceHardCapEnabled: true,
          voiceOverageEnabled: false,
        },
      },
      reserveSeconds: 60,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "daily_voice_allowance_exhausted",
    });
    expect(VoiceUsageLedger.updateMany).toHaveBeenCalled();
    expect(AlertService.createSystemAlert).not.toHaveBeenCalled();
  });
});
