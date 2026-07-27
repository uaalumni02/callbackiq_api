import {
  enumerateDateKeys,
  formatZonedIso,
  zonedDateTimeToUtc,
} from "../../src/services/scheduling/timezone.service.js";

describe("timezone scheduling helpers", () => {
  test("converts a normal New York wall-clock time to UTC", () => {
    const value = zonedDateTimeToUtc({
      dateKey: "2026-07-27",
      timeKey: "13:00",
      timeZone: "America/New_York",
    });

    expect(value.toISOString()).toBe("2026-07-27T17:00:00.000Z");
    expect(formatZonedIso(value, "America/New_York")).toBe(
      "2026-07-27T13:00:00-04:00",
    );
  });

  test("rejects a nonexistent daylight-saving wall-clock time", () => {
    expect(() =>
      zonedDateTimeToUtc({
        dateKey: "2026-03-08",
        timeKey: "02:30",
        timeZone: "America/New_York",
      }),
    ).toThrow(/does not exist/i);
  });

  test("accepts the first occurrence of an ambiguous fall-back time", () => {
    const value = zonedDateTimeToUtc({
      dateKey: "2026-11-01",
      timeKey: "01:30",
      timeZone: "America/New_York",
    });

    expect(formatZonedIso(value, "America/New_York")).toMatch(
      /^2026-11-01T01:30:00-0[45]:00$/,
    );
  });

  test("enumerates a closed date range", () => {
    expect(enumerateDateKeys("2026-07-27", "2026-07-30")).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
  });
});
