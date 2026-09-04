import {
  reconcileOrphanedInboundSmsJobs,
} from "../../src/services/messaging/smsProcessingQueue.service.js";
import { logOperationalEvent } from "../../src/helpers/logging/safeLogger.js";
import {
  reconcileSmsIngressOnce,
} from "../../src/workers/smsIngressReconciliation.worker.js";

jest.mock("../../src/services/messaging/smsProcessingQueue.service.js", () => ({
  reconcileOrphanedInboundSmsJobs: jest.fn(),
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalEvent: jest.fn(),
  logOperationalError: jest.fn(),
}));

describe("SMS ingress reconciliation worker", () => {
  beforeEach(() => jest.clearAllMocks());

  test("surfaces repaired orphan counts in operational telemetry", async () => {
    reconcileOrphanedInboundSmsJobs.mockResolvedValue({
      examined: 2,
      repaired: 1,
    });

    await expect(reconcileSmsIngressOnce()).resolves.toEqual({
      examined: 2,
      repaired: 1,
    });
    expect(logOperationalEvent).toHaveBeenCalledWith(
      "sms.ingress_orphans_repaired",
      { examined: 2, repaired: 1 },
    );
  });
});
