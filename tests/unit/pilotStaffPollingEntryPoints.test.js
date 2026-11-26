import { runApprovalSms } from "../../src/services/scheduling/approvalSms.service.js";
import { runStaffSms } from "../../src/services/staffSms.service.js";
import { pollStaffSms } from "../../src/services/notifications/staffSmsPolling.service.js";
jest.mock(
  "../../src/services/notifications/staffSmsPolling.service.js",
  () => ({ pollStaffSms: jest.fn() }),
);
beforeEach(() => jest.clearAllMocks());
describe.each([
  [runApprovalSms, true],
  [runStaffSms, false],
])("H02 polling entry points", (run, approval) => {
  test("default invocation chooses its own partition", async () => {
    pollStaffSms.mockResolvedValue({ sent: 0 });
    await expect(run()).resolves.toEqual({ sent: 0 });
    expect(pollStaffSms).toHaveBeenCalledWith({ approval });
  });
  test("caller options cannot switch the partition", async () => {
    pollStaffSms.mockResolvedValue({ sent: 1 });
    await expect(run({ limit: 1, approval: !approval })).resolves.toEqual({
      sent: 1,
    });
    expect(pollStaffSms).toHaveBeenCalledWith({ limit: 1, approval });
  });
  test("provider or database failure propagates without reporting a send", async () => {
    const failure = new Error("synthetic polling outage");
    pollStaffSms.mockRejectedValue(failure);
    await expect(run({ limit: 1 })).rejects.toBe(failure);
  });
});
