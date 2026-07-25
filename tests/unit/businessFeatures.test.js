
import {
  BUSINESS_FEATURE_DEFAULTS,
  getBusinessCalendarProvider,
  getBusinessFeatures,
  isBusinessFeatureEnabled,
} from "../../src/helpers/businessFeatures.js";

describe("businessFeatures helper", () => {
  test("returns safe defaults when a business has no feature object", () => {
    expect(getBusinessFeatures({})).toEqual(BUSINESS_FEATURE_DEFAULTS);
  });

  test("merges stored values over the rollout defaults", () => {
    const features = getBusinessFeatures({
      features: {
        missedCallSmsEnabled: false,
        aiQualificationEnabled: false,
        calendarProvider: "google",
      },
    });

    expect(features).toEqual({
      missedCallSmsEnabled: false,
      aiQualificationEnabled: false,
      aiBookingEnabled: false,
      automatedFollowUpEnabled: false,
      voiceAiEnabled: false,
      revenueTrackingEnabled: false,
      calendarProvider: "google",
    });
  });

  test("supports Mongoose-style subdocuments", () => {
    const features = getBusinessFeatures({
      toObject: () => ({
        features: {
          toObject: () => ({
            missedCallSmsEnabled: false,
          }),
        },
      }),
    });

    expect(features.missedCallSmsEnabled).toBe(false);
    expect(features.aiQualificationEnabled).toBe(true);
  });

  test("returns true only for enabled boolean feature flags", () => {
    const business = {
      features: {
        missedCallSmsEnabled: true,
        aiQualificationEnabled: false,
        calendarProvider: "internal",
      },
    };

    expect(
      isBusinessFeatureEnabled(business, "missedCallSmsEnabled"),
    ).toBe(true);

    expect(
      isBusinessFeatureEnabled(business, "aiQualificationEnabled"),
    ).toBe(false);

    expect(
      isBusinessFeatureEnabled(business, "calendarProvider"),
    ).toBe(false);

    expect(
      isBusinessFeatureEnabled(business, "missingFeature"),
    ).toBe(false);
  });

  test("returns the configured calendar provider", () => {
    expect(
      getBusinessCalendarProvider({
        features: {
          calendarProvider: "jobber",
        },
      }),
    ).toBe("jobber");

    expect(getBusinessCalendarProvider({})).toBe("internal");
  });
});
