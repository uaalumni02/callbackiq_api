import AttributionTouch from "../../src/models/attributionTouch.js";

describe("AttributionTouch model", () => {
  test("supports immutable measured attribution evidence", () => {
    const touch = new AttributionTouch({
      business: "507f1f77bcf86cd799439011",
      source: "Google Ads",
      method: "tracking_number",
      confidence: "high",
    });

    expect(touch.method).toBe("tracking_number");
    expect(touch.confidence).toBe("high");
  });
});
