import {
  demoRequestSchema,
  publicDemoScheduleSchema,
  updateDemoRequestSchema,
} from "../../src/validator/demoRequest.js";

describe("demo request booking validators", () => {
  test("accepts structured qualification and attribution fields", async () => {
    const value = await demoRequestSchema.validateAsync({
      fullName: "John Smith",
      email: "owner@example.com",
      phone: "404-555-1000",
      businessName: "ABC Plumbing",
      businessType: "plumbing",
      monthlyCallVolume: "500_1000",
      visitorTimezone: "America/New_York",
      message: "After-hours calls",
      source: "book_demo_page",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "atlanta-plumbing",
      referrer: "https://www.google.com/",
      faxNumber: "",
    });

    expect(value.monthlyCallVolume).toBe("500_1000");
    expect(value.utmSource).toBe("google");
  });

  test("rejects unstructured monthly call volume", async () => {
    await expect(
      demoRequestSchema.validateAsync({
        fullName: "John Smith",
        email: "owner@example.com",
        businessName: "ABC Plumbing",
        monthlyCallVolume: "around 300",
      }),
    ).rejects.toBeTruthy();
  });

  test("accepts the expanded sales pipeline statuses", async () => {
    for (const status of [
      "new",
      "contacted",
      "scheduled",
      "completed",
      "converted",
      "lost",
      "no_show",
      "cancelled",
      "closed",
      "spam",
    ]) {
      await expect(
        updateDemoRequestSchema.validateAsync({ status }),
      ).resolves.toMatchObject({ status });
    }
  });

  test("requires a secure booking token and ISO appointment time", async () => {
    await expect(
      publicDemoScheduleSchema.validateAsync({
        token: "short",
        scheduledAt: "not-a-date",
      }),
    ).rejects.toBeTruthy();

    await expect(
      publicDemoScheduleSchema.validateAsync({
        token: "a".repeat(40),
        scheduledAt: "2026-08-10T14:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      token: "a".repeat(40),
    });
  });
});
