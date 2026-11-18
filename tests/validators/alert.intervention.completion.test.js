import {
  alertSchema,
  updateAlertSchema,
} from "../../src/validator/alert.js";

const ID = "507f1f77bcf86cd799439011";

describe("alert intervention validation", () => {
  const allowed = (schema, field) => schema.describe().keys[field].allow;

  test.each(allowed(alertSchema, 'type'))("accepts intervention type %s", (type) => {
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

  test.each(allowed(updateAlertSchema, 'status'))("allows the alert read-state update %s", status => {
    expect(updateAlertSchema.validate({ status }).error).toBeUndefined();
  });

  test("keeps intervention resolution off the read-state endpoint", () => {
    const interventionStatuses = allowed(alertSchema, 'status').filter(status =>
      !allowed(updateAlertSchema, 'status').includes(status));
    expect(interventionStatuses).toContain("resolved");
    for (const status of interventionStatuses) {
      expect(updateAlertSchema.validate({ status }).error).toBeDefined();
    }
    expect(updateAlertSchema.validate({ status: "read", resolution: "Resolved" }).error).toBeDefined();
    expect(alertSchema.validate({
      title: "Review", message: "Customer needs help", type: "human_requested", assignedTo: "not-an-object-id",
    }).error?.details[0].path).toEqual(["assignedTo"]);
  });
});
