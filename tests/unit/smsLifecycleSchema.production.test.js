import Conversation from "../../src/models/conversation.js";

describe("mature SMS conversation persistence contract", () => {
  test("manual approval booking state is persistable", () => {
    const conversation = new Conversation({
      business: "507f1f77bcf86cd799439011",
      customerPhone: "+14045550123",
      bookingState: { status: "pending_business_confirmation" },
    });
    expect(conversation.validateSync()?.errors?.["bookingState.status"]).toBeUndefined();
  });


  test("handoff_pending is persistable without claiming human ownership", () => {
    const conversation = new Conversation({
      business: "507f1f77bcf86cd799439011",
      customerPhone: "+14045550123",
      aiEnabled: true,
      humanTakeover: false,
      orchestration: { phase: "handoff_pending", handoffStatus: "acknowledged" },
    });
    expect(conversation.validateSync()).toBeUndefined();
  });

  test("orchestration phase and lifecycle state are persistable", () => {
    const conversation = new Conversation({
      business: "507f1f77bcf86cd799439011",
      customerPhone: "+14045550123",
      orchestration: { phase: "awaiting_business_approval", lastIntent: "scheduling" },
      lifecycle: { recoveryNudgeCount: 1 },
    });
    expect(conversation.validateSync()).toBeUndefined();
  });
});
