import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import { generateAIReplyResult } from "../../src/services/aiReplyService.js";

jest.mock("../../src/services/booking/bookingStateMachine.service.js", () => ({
  __esModule: true,
  default: {
    handle: jest.fn(),
  },
}));

describe("AI booking safety ordering", () => {
  beforeEach(() => {
    BookingStateMachineService.handle.mockReset();
  });

  test("does not execute booking tools for a safety hazard midway through booking", async () => {
    const result = await generateAIReplyResult({
      business: {
        _id: "507f1f77bcf86cd799439011",
        businessName: "Test Plumbing",
        businessType: "plumbing",
        features: { aiBookingEnabled: true },
      },
      lead: {
        _id: "507f1f77bcf86cd799439012",
        phone: "+14045550199",
      },
      customerMessage: "I smell gas and my wife passed out",
      messages: [],
    });

    expect(result.messageCategory).toBe("emergency");
    expect(result.riskFlags).toContain("safety_hazard");
    expect(result.shouldAlertOwner).toBe(true);
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  });
});
