import CallLog from "../../src/models/callLog.js";
import { processTwilioCallStatus } from "../../src/services/twilioCallStatus.service.js";

jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitCallUpdated: jest.fn() },
}));

describe("Twilio call status transitions", () => {
  beforeEach(() => jest.clearAllMocks());

  test("advances a missed call record to answered", async () => {
    CallLog.findOneAndUpdate.mockResolvedValue({ _id: "call-1", status: "answered" });
    await processTwilioCallStatus({
      businessId: "business-1",
      payload: { CallSid: "CA123", CallStatus: "completed", CallDuration: "42" },
    });
    expect(CallLog.findOneAndUpdate).toHaveBeenCalledWith(
      {
        business: "business-1",
        providerCallId: "CA123",
        status: { $in: ["missed", "answered"] },
      },
      expect.objectContaining({
        $set: { status: "answered" },
        $max: { durationSeconds: 42 },
      }),
      { returnDocument: "after" },
    );
  });

  test("records a conflicting terminal status without overwriting the winner", async () => {
    CallLog.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "call-1", status: "answered" });
    await processTwilioCallStatus({
      businessId: "business-1",
      payload: { CallSid: "CA123", CallStatus: "no-answer" },
    });
    const conflictEvent = CallLog.findOneAndUpdate.mock.calls[1][1].$push.providerStatusEvents.$each[0];
    expect(conflictEvent).toMatchObject({ applied: false, conflict: true });
  });
});
