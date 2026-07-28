import { deterministicEventId } from "../../src/integrations/scheduling/googleCalendar.provider.js";

describe("Google Calendar provider", () => {
  test("event IDs are deterministic and Google-compatible", () => {
    const appointment = {
      _id: "507f1f77bcf86cd799439011",
      business: "507f191e810c19729de860ea",
    };
    const first = deterministicEventId(appointment);
    const second = deterministicEventId(appointment);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });
});
