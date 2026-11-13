import {
  parseEventDate,
  resolveNumberLifecycleStatus,
  numberLifecycleRank,
  shouldIgnoreNumberLifecycleEvent,
} from "../../src/services/a2pNumberLifecycle.policy.js";

describe("A2P number-lifecycle policy", () => {
  describe("parseEventDate", () => {
    test.each([
      ["ISO UTC", "2027-01-15T08:00:00.000Z", 1_800_000_000_000],
      ["ISO offset", "2027-01-15T03:00:00-05:00", 1_800_000_000_000],
      ["date-only string", "2027-01-15", 1_799_971_200_000],
      ["RFC date string", "Fri, 15 Jan 2027 08:00:00 GMT", 1_800_000_000_000],
      ["Date object", new Date(1_800_000_000_000), 1_800_000_000_000],
      ["epoch milliseconds", 1_800_000_000_000, 1_800_000_000_000],
      ["millisecond string", "1800000000000", 1_800_000_000_000],
      ["epoch seconds", 1_800_000_000, 1_800_000_000_000],
      ["second string", "1800000000", 1_800_000_000_000],
      ["trimmed second string", " 1800000000 ", 1_800_000_000_000],
      ["fractional seconds", 1_800_000_000.125, 1_800_000_000_125],
      ["negative seconds", -1_800_000_000, -1_800_000_000_000],
      ["negative milliseconds", -1_800_000_000_000, -1_800_000_000_000],
      ["zero", 0, 0],
      ["zero string", "0", 0],
      ["millisecond threshold", 1_000_000_000_000, 1_000_000_000_000],
      ["below threshold", 999_999_999_999, 999_999_999_999_000],
      // Preserve the numeric threshold even when the caller supplies a Date.
      ["early Date object", new Date(1_000), 1_000_000],
    ])("parses %s using the existing timestamp rules", (_label, input, expected) => {
      expect(parseEventDate(input).getTime()).toBe(expected);
    });

    test.each([
      ["undefined", undefined],
      ["null", null],
      ["empty", ""],
      ["whitespace", "   "],
      ["invalid text", "not-a-date"],
      ["invalid Date", new Date(NaN)],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["out-of-range timestamp", 8_640_000_000_000_001],
    ])("returns null for %s", (_label, input) => {
      expect(parseEventDate(input)).toBeNull();
    });

    test("copies rather than mutates an input Date", () => {
      const input = new Date(1_800_000_000_000);
      const result = parseEventDate(input);
      expect(result).not.toBe(input);
      expect(input.getTime()).toBe(1_800_000_000_000);
      expect(result.getTime()).toBe(input.getTime());
    });
  });

  describe("resolveNumberLifecycleStatus", () => {
    test.each([
      ["number-registration.successful", "", "REGISTERED"],
      ["number-registration.pending", "", "PENDING_REGISTRATION"],
      ["number-registration.failed", "", "FAILURE"],
      ["number-registration.failure", "", "FAILURE"],
      ["number-deregistration.successful", "", "DEREGISTERED"],
      ["number-deregistration.pending", "", "PENDING_DEREGISTRATION"],
      ["number-deregistration.failed", "", "DEREGISTRATION_FAILED"],
      ["number-deregistration.failure", "", "DEREGISTRATION_FAILED"],
      ["com.twilio.messaging.compliance.number-registration.successful", "", "REGISTERED"],
      [" NUMBER-REGISTRATION.PENDING ", "", "PENDING_REGISTRATION"],
      ["unknown-event", "", "PENDING_REGISTRATION"],
      ["unknown.successful", "", "REGISTERED"],
      ["number-registration.pending", " registered ", "REGISTERED"],
      ["number-registration.successful", "failure", "FAILURE"],
      ["number-deregistration.successful", "REGISTERED", "DEREGISTERED"],
      ["number-deregistration.pending", "REGISTERED", "PENDING_DEREGISTRATION"],
      ["number-deregistration.failed", "REGISTERED", "DEREGISTRATION_FAILED"],
      // Supplied unknown statuses pass through; this is not status validation.
      ["unknown-event", " future_status ", "FUTURE_STATUS"],
    ])("resolves %s / %s to %s", (eventType, externalStatus, expected) => {
      expect(resolveNumberLifecycleStatus({ eventType, externalStatus })).toBe(expected);
    });

    test("defaults missing event information to pending registration", () => {
      expect(resolveNumberLifecycleStatus()).toBe("PENDING_REGISTRATION");
    });
  });

  describe("numberLifecycleRank", () => {
    test.each([
      ["DEREGISTERED", 100],
      ["DEREGISTRATION_FAILED", 96],
      ["PENDING_DEREGISTRATION", 95],
      ["FAILURE", 90],
      ["FAILED", 90],
      ["REGISTERED", 80],
      ["PENDING_REGISTRATION", 10],
      ["unknown", 10],
      [" registered ", 80],
      [undefined, 10],
      [null, 10],
    ])("ranks %s as %s", (status, expected) => {
      expect(numberLifecycleRank(status)).toBe(expected);
    });

    test("orders pending, registered, failure and deregistration states", () => {
      const ranks = ["PENDING_REGISTRATION", "REGISTERED", "FAILURE",
        "PENDING_DEREGISTRATION", "DEREGISTRATION_FAILED", "DEREGISTERED"]
        .map(numberLifecycleRank);
      expect(ranks.every((rank, index) => index === 0 || rank > ranks[index - 1])).toBe(true);
      expect(numberLifecycleRank("FAILURE")).toBe(numberLifecycleRank("FAILED"));
    });
  });

  describe("shouldIgnoreNumberLifecycleEvent", () => {
    const previous = {
      lastEventId: "previous",
      lastEventAt: "2027-01-15T08:00:00.000Z",
      lastEventRank: 80,
    };

    test("rejects duplicate IDs even when the incoming event is newer and stronger", () => {
      expect(shouldIgnoreNumberLifecycleEvent({ ...previous, eventId: "previous",
        eventAt: "2027-01-15T08:01:00.000Z", eventRank: 100 })).toBe("duplicate");
    });

    test("rejects an older event even when its rank is higher", () => {
      expect(shouldIgnoreNumberLifecycleEvent({ ...previous, eventId: "older",
        eventAt: "2027-01-15T07:59:59.000Z", eventRank: 100 })).toBe("stale");
    });

    test.each([10, 80, 100])("accepts a newer event with rank %s", (eventRank) => {
      expect(shouldIgnoreNumberLifecycleEvent({ ...previous, eventId: "newer",
        eventAt: "2027-01-15T08:01:00.000Z", eventRank })).toBe("");
    });

    test.each([
      ["REGISTERED", "PENDING_REGISTRATION", "stale"],
      ["REGISTERED", "REGISTERED", ""],
      ["REGISTERED", "FAILURE", ""],
      ["FAILURE", "FAILED", ""],
      ["DEREGISTERED", "DEREGISTRATION_FAILED", "stale"],
      ["PENDING_DEREGISTRATION", "DEREGISTERED", ""],
    ])("breaks equal-time ties between %s and %s", (lastStatus, status, expected) => {
      expect(shouldIgnoreNumberLifecycleEvent({ ...previous, eventId: "same-time",
        lastEventRank: numberLifecycleRank(lastStatus),
        eventRank: numberLifecycleRank(status), eventAt: 1_800_000_000 })).toBe(expected);
    });

    test.each([null, undefined, "not-a-date"])("rejects a downgrade with incoming timestamp %s", (eventAt) => {
      expect(shouldIgnoreNumberLifecycleEvent({ ...previous, eventAt, eventRank: 10 })).toBe("stale");
    });

    test.each([80, 100])("accepts a missing incoming timestamp with rank %s", (eventRank) => {
      expect(shouldIgnoreNumberLifecycleEvent({ ...previous, eventRank })).toBe("");
    });

    test("accepts an event with no prior state", () => {
      expect(shouldIgnoreNumberLifecycleEvent({ eventId: "first",
        eventAt: "2027-01-15T08:00:00.000Z", eventRank: 10 })).toBe("");
      expect(shouldIgnoreNumberLifecycleEvent()).toBe("");
    });

    test("accepts a dated event without a valid prior timestamp even at a lower rank", () => {
      expect(shouldIgnoreNumberLifecycleEvent({ lastEventAt: "invalid",
        lastEventRank: 100, eventAt: "2027-01-15T08:00:00.000Z", eventRank: 10 })).toBe("");
    });
  });
});
