import mongoose from "mongoose";

import VoiceUsageLedger from "../../src/models/voiceUsageLedger.js";
import VoiceUsageReservation from "../../src/models/voiceUsageReservation.js";
import AlertService from "../../src/services/alert.service.js";
import {
  reserveVoiceUsage,
} from "../../src/services/voiceUsage.service.js";

jest.mock("mongoose", () => ({
  __esModule: true,
  default: {
    isValidObjectId: jest.fn(),
    startSession: jest.fn(),
  },
}));

jest.mock("../../src/models/voiceUsageLedger.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
  },
}));

jest.mock("../../src/models/voiceUsageReservation.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock("../../src/models/voiceUsageReconciliation.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createSystemAlert: jest.fn() },
}));

describe("voice usage hard caps", () => {
  const BUSINESS_ID = "64f000000000000000000001";
  const SESSION_ID = "64f000000000000000000004";

  beforeEach(() => {
    jest.clearAllMocks();
    mongoose.isValidObjectId.mockReturnValue(true);
    mongoose.startSession.mockResolvedValue({
      withTransaction: jest.fn(async (work) => work()),
      endSession: jest.fn().mockResolvedValue(undefined),
    });
    VoiceUsageReservation.findOne.mockResolvedValue(null);
    VoiceUsageReservation.create.mockResolvedValue({
      _id: "reservation-1",
      reservationKey: `voice:${BUSINESS_ID}:${SESSION_ID}:initial`,
      requestedSeconds: 60,
    });
    VoiceUsageReservation.updateOne.mockResolvedValue({ modifiedCount: 1 });
    VoiceUsageLedger.updateMany.mockResolvedValue({ modifiedCount: 2 });
  });

  test("rejects a call that would exceed a daily hard cap", async () => {
    const daily = {
      _id: "day",
      periodType: "day",
      periodKey: "2026-08-03",
      completedSeconds: 3590,
      reservedSeconds: 0,
      thresholdAlertsSent: [],
    };
    const monthly = {
      _id: "month",
      periodType: "month",
      periodKey: "2026-08",
      completedSeconds: 3590,
      reservedSeconds: 0,
      thresholdAlertsSent: [],
    };

    VoiceUsageLedger.findOneAndUpdate
      .mockResolvedValueOnce(daily)
      .mockResolvedValueOnce(monthly)
      .mockResolvedValueOnce(null);

    const result = await reserveVoiceUsage({
      business: {
        _id: BUSINESS_ID,
        voiceSettings: {
          dailyVoiceMinutes: 60,
          monthlyVoiceMinutes: 1000,
          voiceHardCapEnabled: true,
          voiceOverageEnabled: false,
        },
      },
      sessionId: SESSION_ID,
      reserveSeconds: 60,
      reservationKey: `voice:${BUSINESS_ID}:${SESSION_ID}:initial`,
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "daily_voice_allowance_exhausted",
    });
    expect(VoiceUsageReservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        business: BUSINESS_ID,
        session: SESSION_ID,
        requestedSeconds: 60,
        state: "preparing",
      }),
    );
    expect(VoiceUsageReservation.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "reservation-1", state: "preparing" }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: "rejected",
          releaseReason: "daily_voice_allowance_exhausted",
        }),
      }),
    );
    expect(VoiceUsageLedger.updateMany).toHaveBeenCalled();
    expect(AlertService.createSystemAlert).not.toHaveBeenCalled();
  });
});
