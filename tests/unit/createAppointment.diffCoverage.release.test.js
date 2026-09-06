
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";
import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import AlertService from "../../src/services/alert.service.js";
import {
  getAiBookableService,
  getSchedulingPolicy,
} from "../../src/services/scheduling/appointmentPolicy.service.js";

jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: jest.fn(),
  },
}));

jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getAiBookableService: jest.fn(),
  getSchedulingPolicy: jest.fn(),
}));

describe(
  "createAppointment changed-code release coverage",
  () => {
    const business = {
      _id: "business-1",
    };

    beforeEach(() => {
      jest.clearAllMocks();

      getSchedulingPolicy.mockResolvedValue({
        manualApprovalHoldMinutes: 45,
      });

      getAiBookableService.mockResolvedValue({
        id: "service-1",
        name: "Water heater repair",
        requiresHumanReview: true,
      });

      AlertService.createSystemAlert
        .mockResolvedValue({});
    });

    test(
      "creates an AI hold and raises a high-priority approval alert",
      async () => {
        const held = {
          _id: "appointment-1",
          status: "held",
          requiresBusinessApproval: true,
          startAt:
            "2026-09-08T14:00:00.000Z",
          heldExpiresAt:
            "2026-09-08T14:45:00.000Z",
        };

        AppointmentService.create
          .mockResolvedValue(held);

        const result =
          await createAppointmentTool({
            business,
            idempotencyKey:
              "coverage-create-1",
            input: {
              serviceOffering:
                "service-1",
              lead: "lead-1",
              conversation:
                "conversation-1",
              urgency: "emergency",
              startAt:
                "2026-09-08T14:00:00.000Z",
              notes:
                "Customer requested morning service.",
            },
          });

        expect(result).toBe(held);

        expect(
          AppointmentService.create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            confirm: false,
            idempotencyKey:
              "coverage-create-1",
            input:
              expect.objectContaining({
                source: "sms",
                bookedBy: "ai",
                requiresBusinessApproval:
                  true,
                holdMinutes: 45,
              }),
          }),
        );

        expect(
          AppointmentService.create.mock
            .calls[0][0].input.notes,
        ).toMatch(
          /human review/i,
        );

        expect(
          AlertService.createSystemAlert,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            priority: "high",
            metadata:
              expect.objectContaining({
                leadId: "lead-1",
                conversationId:
                  "conversation-1",
              }),
          }),
        );
      },
    );

    test(
      "uses fallback hold settings and does not alert for a non-held result",
      async () => {
        getSchedulingPolicy
          .mockResolvedValue({
            manualApprovalHoldMinutes:
              0,
          });

        getAiBookableService
          .mockResolvedValue({
            id: "service-1",
            requiresHumanReview: false,
          });

        const result = {
          _id: "appointment-2",
          status: "failed",
          requiresBusinessApproval: true,
        };

        AppointmentService.create
          .mockResolvedValue(result);

        await createAppointmentTool({
          business,
          idempotencyKey:
            "coverage-create-2",
          input: {
            serviceOffering:
              "service-1",
            source: "voice",
            urgency: "medium",
            notes: "",
          },
        });

        expect(
          AppointmentService.create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            confirm: false,
            input:
              expect.objectContaining({
                source: "voice",
                holdMinutes: 30,
              }),
          }),
        );

        expect(
          AlertService.createSystemAlert,
        ).not.toHaveBeenCalled();
      },
    );

    test(
      "does not fail appointment creation when the approval alert fails",
      async () => {
        const held = {
          _id: "appointment-3",
          status: "held",
          requiresBusinessApproval: true,
        };

        AppointmentService.create
          .mockResolvedValue(held);

        AlertService.createSystemAlert
          .mockRejectedValue(
            new Error(
              "simulated alert outage",
            ),
          );

        await expect(
          createAppointmentTool({
            business,
            idempotencyKey:
              "coverage-create-3",
            input: {
              serviceOffering:
                "service-1",
              urgency: "low",
            },
          }),
        ).resolves.toBe(held);
      },
    );
  },
);


describe("CALLBACKIQ_FINAL_CREATE_BRANCH_TOP_OFF", () => {
  test(
    "does not emit an approval alert when a held result does not require business approval",
    async () => {
      jest.clearAllMocks();

      getSchedulingPolicy.mockResolvedValue({
        manualApprovalHoldMinutes: 30,
      });

      getAiBookableService.mockResolvedValue({
        id: "service-1",
        name: "Water heater repair",
        requiresHumanReview: false,
      });

      const result = {
        _id: "held-without-approval",
        status: "held",
        requiresBusinessApproval: false,
        startAt:
          "2026-09-08T14:00:00.000Z",
      };

      AppointmentService.create.mockResolvedValue(
        result,
      );

      await expect(
        createAppointmentTool({
          business: {
            _id: "business-1",
          },
          idempotencyKey:
            "final-create-branch",
          input: {
            serviceOffering:
              "service-1",
            urgency: "medium",
          },
        }),
      ).resolves.toBe(result);

      expect(
        AlertService.createSystemAlert,
      ).not.toHaveBeenCalled();
    },
  );
});


describe("CALLBACKIQ_LAST_CREATE_BRANCH", () => {
  test(
    "uses requested startAt in approval metadata when the returned hold has no startAt",
    async () => {
      jest.clearAllMocks();

      getSchedulingPolicy.mockResolvedValue({
        manualApprovalHoldMinutes: 30,
      });

      getAiBookableService.mockResolvedValue({
        id: "service-1",
        name: "Water heater repair",
        requiresHumanReview: false,
      });

      AppointmentService.create.mockResolvedValue({
        _id: "appointment-start-fallback",
        status: "held",
        requiresBusinessApproval: true,
        startAt: null,
        heldExpiresAt: null,
      });

      AlertService.createSystemAlert.mockResolvedValue(
        {},
      );

      const requestedStart =
        "2026-09-08T15:00:00.000Z";

      await createAppointmentTool({
        business: {
          _id: "business-1",
        },
        idempotencyKey:
          "last-create-start-fallback",
        input: {
          serviceOffering:
            "service-1",
          startAt: requestedStart,
          urgency: "medium",
        },
      });

      expect(
        AlertService.createSystemAlert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            startAt: requestedStart,
            heldExpiresAt: null,
          }),
        }),
      );
    },
  );
});
