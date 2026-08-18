import { resolveOwnerPeriod } from "../../src/services/ownerExperiencePeriod.service.js";

test("Today starts at business-local midnight and ends at the current instant", () => {
  const now = new Date("2026-08-18T01:41:00.000Z"); // Aug 17, 9:41 PM in New York
  const result = resolveOwnerPeriod({
    period: "today",
    timeZone: "America/New_York",
    now,
  });

  expect(result.start.toISOString()).toBe("2026-08-17T04:00:00.000Z");
  expect(result.end.toISOString()).toBe(now.toISOString());
  expect(result.label).toBe("Today");
});

test("7d includes seven business-local calendar days", () => {
  const result = resolveOwnerPeriod({
    period: "7d",
    timeZone: "America/New_York",
    now: new Date("2026-08-18T01:41:00.000Z"),
  });

  expect(result.start.toISOString()).toBe("2026-08-11T04:00:00.000Z");
  expect(result.label).toBe("Last 7 days");
});

test("invalid periods safely fall back to Today", () => {
  const result = resolveOwnerPeriod({
    period: "lifetime-but-labeled-today",
    timeZone: "America/New_York",
    now: new Date("2026-08-18T01:41:00.000Z"),
  });

  expect(result.key).toBe("today");
  expect(result.start.toISOString()).toBe("2026-08-17T04:00:00.000Z");
});
