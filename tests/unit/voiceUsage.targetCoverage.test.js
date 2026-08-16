const mockLedgerFindOneAndUpdate = jest.fn();
const mockLedgerUpdateOne = jest.fn();
const mockLedgerUpdateMany = jest.fn();
const mockReservationFindOne = jest.fn();
const mockReservationCreate = jest.fn();
const mockReservationUpdateOne = jest.fn();
const mockReservationFindById = jest.fn();
const mockReservationFind = jest.fn();
const mockReservationUpdateMany = jest.fn();
const mockReconciliationFindOne = jest.fn();
const mockReconciliationCreate = jest.fn();
const mockReconciliationUpdateOne = jest.fn();
const mockAlert = jest.fn();
const mockLogError = jest.fn();
const mockLogWarning = jest.fn();
const mockWithTransaction = jest.fn();
const mockEndSession = jest.fn();
const mockStartSession = jest.fn();
const mockIsValidObjectId = jest.fn();

jest.mock("mongoose", () => ({
  __esModule: true,
  default: {
    startSession: (...args) => mockStartSession(...args),
    isValidObjectId: (...args) => mockIsValidObjectId(...args),
  },
}));
jest.mock("../../src/models/voiceUsageLedger.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args) => mockLedgerFindOneAndUpdate(...args),
    updateOne: (...args) => mockLedgerUpdateOne(...args),
    updateMany: (...args) => mockLedgerUpdateMany(...args),
    find: jest.fn(),
  },
}));
jest.mock("../../src/models/voiceUsageReservation.js", () => ({
  __esModule: true,
  default: {
    findOne: (...args) => mockReservationFindOne(...args),
    create: (...args) => mockReservationCreate(...args),
    updateOne: (...args) => mockReservationUpdateOne(...args),
    findById: (...args) => mockReservationFindById(...args),
    find: (...args) => mockReservationFind(...args),
    updateMany: (...args) => mockReservationUpdateMany(...args),
  },
}));
jest.mock("../../src/models/voiceUsageReconciliation.js", () => ({
  __esModule: true,
  default: {
    findOne: (...args) => mockReconciliationFindOne(...args),
    create: (...args) => mockReconciliationCreate(...args),
    updateOne: (...args) => mockReconciliationUpdateOne(...args),
  },
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: (...args) => mockAlert(...args),
  },
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalError: (...args) => mockLogError(...args),
  logOperationalWarning: (...args) => mockLogWarning(...args),
}));

const voiceUsage = require("../../src/services/voiceUsage.service.js");
const { reserveVoiceUsage } = voiceUsage;

const BUSINESS_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f191e810c19729de860ea";
const NOW = new Date("2026-08-17T12:00:00.000Z");

const BUSINESS = {
  _id: BUSINESS_ID,
  voiceSettings: {
    dailyVoiceMinutes: 240,
    monthlyVoiceMinutes: 4000,
    voiceHardCapEnabled: true,
    voiceOverageEnabled: false,
    voiceUsageWarningThresholds: [70, 85, 100],
  },
};

const makeMongoSession = () => ({
  withTransaction: (...args) => mockWithTransaction(...args),
  endSession: (...args) => mockEndSession(...args),
});

const reservation = (overrides = {}) => ({
  _id: "reservation-1",
  business: BUSINESS_ID,
  session: SESSION_ID,
  reservationKey: "voice:test-key",
  requestedSeconds: 60,
  state: "active",
  reservedPeriodTypes: ["day", "month"],
  dayPeriodKey: "2026-08-17",
  monthPeriodKey: "2026-08",
  ...overrides,
});

const dayLedger = (overrides = {}) => ({
  _id: "ledger-day",
  periodType: "day",
  periodKey: "2026-08-17",
  completedSeconds: 0,
  reservedSeconds: 60,
  thresholdAlertsSent: [],
  ...overrides,
});

const monthLedger = (overrides = {}) => ({
  _id: "ledger-month",
  periodType: "month",
  periodKey: "2026-08",
  completedSeconds: 0,
  reservedSeconds: 60,
  thresholdAlertsSent: [],
  ...overrides,
});

const arrangeSuccessfulReservation = ({
  day = dayLedger(),
  month = monthLedger(),
  savedReservation = reservation(),
} = {}) => {
  mockReservationFindOne.mockResolvedValue(null);
  mockReservationCreate.mockResolvedValue(
    reservation({ state: "preparing", requestedSeconds: 60 }),
  );
  mockReservationFindById.mockResolvedValue(savedReservation);
  mockReservationUpdateOne.mockResolvedValue({ acknowledged: true });
  mockLedgerUpdateOne.mockResolvedValue({ acknowledged: true });
  mockLedgerUpdateMany.mockResolvedValue({ acknowledged: true });
  mockWithTransaction.mockImplementation(async (fn) => fn());
  mockStartSession.mockResolvedValue(makeMongoSession());

  mockLedgerFindOneAndUpdate.mockImplementation(async (query) => {
    if (query.periodType === "day") return dayLedger({ _id: "ledger-day", reservedSeconds: 0 });
    if (query.periodType === "month") return monthLedger({ _id: "ledger-month", reservedSeconds: 0 });
    if (query._id === "ledger-day") return day;
    if (query._id === "ledger-month") return month;
    throw new Error(`Unexpected ledger query: ${JSON.stringify(query)}`);
  });
};

describe("voiceUsage reserve target coverage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsValidObjectId.mockImplementation((value) =>
      [BUSINESS_ID, SESSION_ID].includes(String(value)),
    );
    mockReservationUpdateOne.mockResolvedValue({ acknowledged: true });
    mockLedgerUpdateOne.mockResolvedValue({ acknowledged: true });
    mockLedgerUpdateMany.mockResolvedValue({ acknowledged: true });
    mockEndSession.mockResolvedValue();
    mockAlert.mockResolvedValue({ _id: "alert" });
  });

  test("rejects missing business before touching persistence", async () => {
    await expect(
      reserveVoiceUsage({ business: null, sessionId: SESSION_ID, now: NOW }),
    ).resolves.toEqual({
      allowed: false,
      reason: "voice_usage_business_required",
    });
    expect(mockReservationFindOne).not.toHaveBeenCalled();
  });

  test("rejects invalid or absent session id", async () => {
    mockIsValidObjectId.mockReturnValue(false);
    await expect(
      reserveVoiceUsage({ business: BUSINESS, sessionId: "", now: NOW }),
    ).resolves.toEqual({
      allowed: false,
      reason: "voice_usage_session_required",
    });
  });

  test.each(["active", "committed"])(
    "replays an existing %s reservation as allowed",
    async (state) => {
      mockReservationFindOne.mockResolvedValue(
        reservation({
          state,
          _id: `${state}-id`,
          requestedSeconds: 45,
        }),
      );

      await expect(
        reserveVoiceUsage({
          business: BUSINESS,
          sessionId: SESSION_ID,
          reservationKey: "voice:test-key",
          now: NOW,
        }),
      ).resolves.toEqual({
        allowed: true,
        replayed: true,
        reservationId: `${state}-id`,
        reservationKey: "voice:test-key",
        reservedSeconds: 45,
      });

      expect(mockReservationCreate).not.toHaveBeenCalled();
    },
  );

  test("replays rejected reservation using provider-specific release reason", async () => {
    mockReservationFindOne.mockResolvedValue(
      reservation({
        state: "rejected",
        releaseReason: "daily_voice_allowance_exhausted",
      }),
    );

    await expect(
      reserveVoiceUsage({
        business: BUSINESS,
        sessionId: SESSION_ID,
        reservationKey: "voice:test-key",
        now: NOW,
      }),
    ).resolves.toEqual({
      allowed: false,
      replayed: true,
      reason: "daily_voice_allowance_exhausted",
    });
  });

  test("rejected reservation without reason falls back to exhausted", async () => {
    mockReservationFindOne.mockResolvedValue(
      reservation({ state: "rejected", releaseReason: "" }),
    );
    const result = await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reservationKey: "voice:test-key",
      now: NOW,
    });
    expect(result.reason).toBe("voice_allowance_exhausted");
  });

  test.each(["released", "expired", "unknown"])(
    "non-active replay state %s is blocked as released",
    async (state) => {
      mockReservationFindOne.mockResolvedValue(reservation({ state }));
      const result = await reserveVoiceUsage({
        business: BUSINESS,
        sessionId: SESSION_ID,
        reservationKey: "voice:test-key",
        now: NOW,
      });
      expect(result).toEqual({
        allowed: false,
        replayed: true,
        reason: "voice_usage_reservation_released",
      });
    },
  );

  test("successful reservation is atomic across day and month ledgers", async () => {
    arrangeSuccessfulReservation();

    const result = await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reserveSeconds: 60,
      reservationKey: "voice:test-key",
      ownerToken: "worker-A",
      now: NOW,
    });

    expect(result).toEqual({
      allowed: true,
      reservationId: "reservation-1",
      reservationKey: "voice:test-key",
      reservedSeconds: 60,
    });

    expect(mockReservationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        business: BUSINESS_ID,
        session: SESSION_ID,
        reservationKey: "voice:test-key",
        requestedSeconds: 60,
        state: "preparing",
        dayPeriodKey: "2026-08-17",
        monthPeriodKey: "2026-08",
        reservedPeriodTypes: [],
        ownerToken: "worker-A",
      }),
    );
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockEndSession).toHaveBeenCalledTimes(1);
    expect(mockReservationUpdateOne).toHaveBeenCalledWith(
      { _id: "reservation-1", state: "preparing" },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: "active",
          reservedPeriodTypes: ["day", "month"],
        }),
      }),
      expect.objectContaining({ session: expect.any(Object) }),
    );
  });

  test("hard-cap reservation uses atomic $expr limit guard", async () => {
    arrangeSuccessfulReservation();

    await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reserveSeconds: 60,
      reservationKey: "voice:hard-cap",
      now: NOW,
    });

    const reserveCalls = mockLedgerFindOneAndUpdate.mock.calls.filter(
      ([query]) => query._id,
    );
    expect(reserveCalls).toHaveLength(2);
    for (const [query] of reserveCalls) {
      expect(query.$expr).toEqual(
        expect.objectContaining({
          $lte: expect.any(Array),
        }),
      );
    }
  });

  test("overage-enabled reservation omits hard-cap expression", async () => {
    arrangeSuccessfulReservation();
    await reserveVoiceUsage({
      business: {
        ...BUSINESS,
        voiceSettings: {
          ...BUSINESS.voiceSettings,
          voiceOverageEnabled: true,
        },
      },
      sessionId: SESSION_ID,
      reservationKey: "voice:overage",
      now: NOW,
    });

    const reserveCalls = mockLedgerFindOneAndUpdate.mock.calls.filter(
      ([query]) => query._id,
    );
    for (const [query] of reserveCalls) {
      expect(query.$expr).toBeUndefined();
    }
  });

  test("disabled hard cap also omits limit expression", async () => {
    arrangeSuccessfulReservation();
    await reserveVoiceUsage({
      business: {
        ...BUSINESS,
        voiceSettings: {
          ...BUSINESS.voiceSettings,
          voiceHardCapEnabled: false,
        },
      },
      sessionId: SESSION_ID,
      reservationKey: "voice:no-cap",
      now: NOW,
    });

    const reserveCalls = mockLedgerFindOneAndUpdate.mock.calls.filter(
      ([query]) => query._id,
    );
    expect(reserveCalls.every(([query]) => !query.$expr)).toBe(true);
  });

  test.each([
    [1, 15],
    [15, 15],
    [60, 60],
    [999999, 86400],
    ["not-a-number", 60],
  ])("reserveSeconds %p clamps to %s", async (input, expected) => {
    arrangeSuccessfulReservation({
      savedReservation: reservation({ requestedSeconds: expected }),
    });

    const result = await reserveVoiceUsage({
      business: {
        ...BUSINESS,
        voiceSettings: {
          ...BUSINESS.voiceSettings,
          voiceOverageEnabled: true,
        },
      },
      sessionId: SESSION_ID,
      reserveSeconds: input,
      reservationKey: `voice:clamp:${String(input)}`,
      now: NOW,
    });

    expect(result.reservedSeconds).toBe(expected);
    expect(mockReservationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requestedSeconds: expected }),
    );
  });

  test("owner token is normalized and truncated", async () => {
    arrangeSuccessfulReservation();
    await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reservationKey: "voice:owner",
      ownerToken: "x".repeat(300),
      now: NOW,
    });
    const created = mockReservationCreate.mock.calls[0][0];
    expect(created.ownerToken).toHaveLength(160);
  });

  test("duplicate reservation insert retries and returns the winner", async () => {
    mockReservationFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        reservation({
          _id: "winner",
          state: "active",
          requestedSeconds: 30,
          reservationKey: "voice:dup",
        }),
      );
    mockReservationCreate.mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: 11000 }),
    );

    await expect(
      reserveVoiceUsage({
        business: BUSINESS,
        sessionId: SESSION_ID,
        reserveSeconds: 30,
        reservationKey: "voice:dup",
        now: NOW,
      }),
    ).resolves.toEqual({
      allowed: true,
      replayed: true,
      reservationId: "winner",
      reservationKey: "voice:dup",
      reservedSeconds: 30,
    });
  });

  test("non-duplicate reservation create failure is propagated", async () => {
    mockReservationFindOne.mockResolvedValue(null);
    mockReservationCreate.mockRejectedValue(new Error("mongo unavailable"));

    await expect(
      reserveVoiceUsage({
        business: BUSINESS,
        sessionId: SESSION_ID,
        reservationKey: "voice:create-fail",
        now: NOW,
      }),
    ).rejects.toThrow("mongo unavailable");
  });

  test("daily hard-cap failure rejects reservation and increments rejected calls", async () => {
    arrangeSuccessfulReservation();
    mockLedgerFindOneAndUpdate.mockImplementation(async (query) => {
      if (query.periodType === "day") return dayLedger({ _id: "ledger-day", reservedSeconds: 0 });
      if (query.periodType === "month") return monthLedger({ _id: "ledger-month", reservedSeconds: 0 });
      if (query._id === "ledger-day") return null;
      return monthLedger();
    });

    const result = await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reservationKey: "voice:daily-reject",
      now: NOW,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "daily_voice_allowance_exhausted",
    });
    expect(mockReservationUpdateOne).toHaveBeenCalledWith(
      { _id: "reservation-1", state: "preparing" },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: "rejected",
          releaseReason: "daily_voice_allowance_exhausted",
        }),
      }),
    );
    expect(mockLedgerUpdateMany).toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockEndSession).toHaveBeenCalled();
  });

  test("monthly hard-cap failure rejects after successful daily reservation", async () => {
    arrangeSuccessfulReservation();
    mockLedgerFindOneAndUpdate.mockImplementation(async (query) => {
      if (query.periodType === "day") return dayLedger({ _id: "ledger-day", reservedSeconds: 0 });
      if (query.periodType === "month") return monthLedger({ _id: "ledger-month", reservedSeconds: 0 });
      if (query._id === "ledger-day") return dayLedger();
      if (query._id === "ledger-month") return null;
      return null;
    });

    const result = await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reservationKey: "voice:monthly-reject",
      now: NOW,
    });

    expect(result.reason).toBe("monthly_voice_allowance_exhausted");
    expect(mockLedgerUpdateMany).toHaveBeenCalled();
  });

  test("unexpected transaction failure fails closed and logs operational error", async () => {
    arrangeSuccessfulReservation();
    mockWithTransaction.mockRejectedValueOnce(new Error("transaction unavailable"));

    const result = await reserveVoiceUsage({
      business: BUSINESS,
      sessionId: SESSION_ID,
      reservationKey: "voice:tx-error",
      now: NOW,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "voice_usage_atomic_reservation_unavailable",
    });
    expect(mockLogError).toHaveBeenCalledWith(
      "voice_usage.atomic_reservation_failed",
      expect.any(Error),
      expect.objectContaining({
        businessId: BUSINESS_ID,
        sessionId: SESSION_ID,
        reservationKey: "voice:tx-error",
      }),
    );
  });

  test("crossed warning thresholds create deduplicated day/month system alerts", async () => {
    arrangeSuccessfulReservation({
      day: dayLedger({
        completedSeconds: 45,
        reservedSeconds: 15,
        thresholdAlertsSent: [],
      }),
      month: monthLedger({
        completedSeconds: 45,
        reservedSeconds: 15,
        thresholdAlertsSent: [],
      }),
    });

    const business = {
      ...BUSINESS,
      voiceSettings: {
        dailyVoiceMinutes: 1,
        monthlyVoiceMinutes: 1,
        voiceHardCapEnabled: false,
        voiceOverageEnabled: true,
        voiceUsageWarningThresholds: [50, 100],
      },
    };

    await reserveVoiceUsage({
      business,
      sessionId: SESSION_ID,
      reserveSeconds: 15,
      reservationKey: "voice:thresholds",
      now: NOW,
    });

    expect(mockAlert).toHaveBeenCalledTimes(4);
    expect(mockAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Voice usage reached 100%",
        priority: "high",
        metadata: expect.objectContaining({ threshold: 100 }),
      }),
    );
    expect(mockLedgerUpdateOne).toHaveBeenCalledTimes(4);
  });

  test("already-sent threshold is skipped", async () => {
    arrangeSuccessfulReservation({
      day: dayLedger({
        completedSeconds: 45,
        reservedSeconds: 15,
        thresholdAlertsSent: [50, 100],
      }),
      month: monthLedger({
        completedSeconds: 45,
        reservedSeconds: 15,
        thresholdAlertsSent: [50, 100],
      }),
    });

    await reserveVoiceUsage({
      business: {
        ...BUSINESS,
        voiceSettings: {
          dailyVoiceMinutes: 1,
          monthlyVoiceMinutes: 1,
          voiceHardCapEnabled: false,
          voiceOverageEnabled: true,
          voiceUsageWarningThresholds: [50, 100],
        },
      },
      sessionId: SESSION_ID,
      reserveSeconds: 15,
      reservationKey: "voice:threshold-skip",
      now: NOW,
    });

    expect(mockAlert).not.toHaveBeenCalled();
  });

  test("alert failure cannot turn an allowed voice reservation into a failure", async () => {
    arrangeSuccessfulReservation({
      day: dayLedger({ completedSeconds: 59, reservedSeconds: 1 }),
      month: monthLedger({ completedSeconds: 0, reservedSeconds: 0 }),
    });
    mockAlert.mockRejectedValueOnce(new Error("alert database down"));

    const result = await reserveVoiceUsage({
      business: {
        ...BUSINESS,
        voiceSettings: {
          dailyVoiceMinutes: 1,
          monthlyVoiceMinutes: 100,
          voiceHardCapEnabled: false,
          voiceOverageEnabled: true,
          voiceUsageWarningThresholds: [100],
        },
      },
      sessionId: SESSION_ID,
      reserveSeconds: 15,
      reservationKey: "voice:alert-error",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
    expect(mockLogError).toHaveBeenCalledWith(
      "voice_usage.threshold_alert_failed",
      expect.any(Error),
      expect.objectContaining({
        businessId: BUSINESS_ID,
        periodType: "day",
        threshold: 100,
      }),
    );
  });
});
