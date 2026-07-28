import {
  alertSchema,
  updateAlertSchema,
} from "../../src/validator/alert.js";

const ID = "507f1f77bcf86cd799439011";

describe("alert intervention validation", () => {
  test.each([
    "safety_emergency",
    "human_requested",
    "angry_customer",
    "high_value_lead",
    "low_ai_confidence",
    "booking_conflict",
    "integration_failure",
    "message_delivery_failure",
    "unanswered_hot_lead",
    "appointment_canceled",
  ])("accepts intervention type %s", (type) => {
    const { error, value } = alertSchema.validate({
      lead: ID,
      conversation: ID,
      appointment: ID,
      assignedTo: ID,
      type,
      title: "Human attention required",
      message: "A staff member needs to review this customer interaction.",
      status: "acknowledged",
      priority: "critical",
      actionRequired: true,
      dueAt: "2026-07-28T18:00:00.000Z",
      reason: "The automated workflow cannot safely continue.",
      recommendedAction: "Call the customer.",
      aiSummary: "Customer requested a person.",
      lastCustomerMessage: "Please call me.",
    });

    expect(error).toBeUndefined();
    expect(value.type).toBe(type);
  });

  test("accepts resolution fields and rejects invalid assignee IDs", () => {
    expect(
      updateAlertSchema.validate({
        status: "resolved",
        resolvedAt: "2026-07-28T18:00:00.000Z",
        resolution: "Customer reached and issue handled.",
        actionRequired: false,
      }).error,
    ).toBeUndefined();

    expect(
      updateAlertSchema.validate({ assignedTo: "not-an-object-id" }).error,
    ).toBeDefined();
  });
});
