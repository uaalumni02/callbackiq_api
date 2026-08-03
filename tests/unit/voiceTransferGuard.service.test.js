import {
  classifyTransferAcceptance,
  buildGuardedDialOptions,
} from "../../src/voice/voiceTransferGuard.service.js";

describe("voice transfer guard", () => {
  test("rejects an answering machine even when the dial connected", () => {
    expect(
      classifyTransferAcceptance({
        answeredBy: "machine_start",
        digits: "1",
        dialCallStatus: "completed",
      }),
    ).toEqual({
      accepted: false,
      reason: "answering_machine_detected",
    });
  });

  test("requires explicit press-1 acceptance", () => {
    expect(
      classifyTransferAcceptance({
        answeredBy: "human",
        digits: "",
        dialCallStatus: "completed",
      }),
    ).toEqual({ accepted: false, reason: "agent_did_not_accept" });
  });

  test("enables AMD but keeps human acceptance authoritative", () => {
    expect(
      buildGuardedDialOptions({
        statusCallback: "/amd",
        action: "/complete",
      }),
    ).toMatchObject({
      answerOnBridge: true,
      machineDetection: "Enable",
      asyncAmd: true,
    });
  });
});
