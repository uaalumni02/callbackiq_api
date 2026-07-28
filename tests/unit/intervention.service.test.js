import Alert from "../../src/models/alert.js";
import SocketService from "../../src/services/socket.service.js";
import InterventionService, {
  normalizeInterventionPriority,
} from "../../src/services/intervention.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { create: jest.fn(), findById: jest.fn(), findOne: jest.fn() },
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitAlertCreated: jest.fn(), emitDashboardRefresh: jest.fn() },
}));

const populatedQuery = (value) => {
  const query = {
    populate: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};

describe("InterventionService", () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ["safety_emergency", "low", "critical"],
    ["human_requested", "normal", "high"],
    ["angry_customer", "medium", "high"],
    ["low_ai_confidence", "low", "medium"],
    ["appointment_canceled", "normal", "medium"],
    ["system", "normal", "medium"],
    ["system", "urgent", "critical"],
    ["system", "invalid", "high"],
  ])("normalizes %s/%s to %s", (type, requested, expected) => {
    expect(normalizeInterventionPriority(type, requested)).toBe(expected);
  });

  test.each([
    ["safety_emergency", "low", "critical", true],
    ["human_requested", "normal", "high", true],
    ["system", "critical", "critical", true],
    ["system", "low", "low", false],
  ])(
    "creates and emits %s/%s as %s interventions",
    async (type, priority, normalizedPriority, eligible) => {
      Alert.create.mockResolvedValue({ _id: "alert-1" });
      const populated = { _id: "alert-1", type, priority: normalizedPriority };
      Alert.findById.mockReturnValue(populatedQuery(populated));

      await expect(
        InterventionService.create({
          businessId: "b1",
          type,
          title: "Title",
          message: "Message",
          priority,
          metadata: { custom: true },
        }),
      ).resolves.toBe(populated);

      expect(Alert.create).toHaveBeenCalledWith(
        expect.objectContaining({
          business: "b1",
          type,
          priority: normalizedPriority,
          metadata: { custom: true, externalNotificationEligible: eligible },
        }),
      );
      expect(SocketService.emitAlertCreated).toHaveBeenCalledWith("b1", populated);
      expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
        "b1",
        `intervention:${type}`,
      );
    },
  );

  test("returns the existing deduplicated alert", async () => {
    Alert.create.mockRejectedValue({ code: 11000 });
    Alert.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: "existing" }),
    });

    await expect(
      InterventionService.create({
        businessId: "b1",
        type: "integration_failure",
        title: "Title",
        message: "Message",
        dedupeKey: "key",
      }),
    ).resolves.toEqual({ _id: "existing" });

    expect(Alert.findOne).toHaveBeenCalledWith({ business: "b1", dedupeKey: "key" });
    expect(SocketService.emitAlertCreated).not.toHaveBeenCalled();
  });

  test("rethrows duplicate-without-key and ordinary failures", async () => {
    Alert.create.mockRejectedValueOnce({ code: 11000 });
    await expect(
      InterventionService.create({
        businessId: "b1",
        type: "system",
        title: "T",
        message: "M",
      }),
    ).rejects.toEqual({ code: 11000 });

    const error = new Error("failure");
    Alert.create.mockRejectedValueOnce(error);
    await expect(
      InterventionService.create({
        businessId: "b1",
        type: "system",
        title: "T",
        message: "M",
        dedupeKey: "k",
      }),
    ).rejects.toBe(error);
  });

  test("builds a provider failure intervention with and without optional values", async () => {
    jest.spyOn(InterventionService, "create").mockResolvedValue({ _id: "alert" });

    await InterventionService.integrationFailure({
      businessId: "b1",
      leadId: "l1",
      conversationId: "c1",
      appointmentId: "a1",
      provider: "Google Calendar",
      error: Object.assign(new Error("timeout"), { code: "TIMEOUT" }),
    });

    expect(InterventionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "integration_failure",
        title: "Google Calendar confirmation failed",
        reason: "timeout",
        metadata: { provider: "Google Calendar", errorCode: "TIMEOUT" },
        dedupeKey: "integration_failure:a1",
      }),
    );

    await InterventionService.integrationFailure({ businessId: "b1" });
    expect(InterventionService.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Scheduling confirmation failed",
        reason: "The scheduling provider returned an error.",
        metadata: { provider: undefined, errorCode: null },
        dedupeKey: null,
      }),
    );
  });
});
