import mongoose from "mongoose";

import AvailabilityRule from "../../src/models/availabilityRule.js";
import Business from "../../src/models/business.js";
import BusinessOperationsSettings from "../../src/models/businessOperationsSettings.js";
import SchedulingPolicy from "../../src/models/schedulingPolicy.js";
import ServiceArea from "../../src/models/serviceArea.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import { evaluateBookingEligibility } from "../../src/services/bookingEligibility.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(connectTestDB);
afterEach(clearTestDB);
afterAll(closeTestDB);

test("permits AI booking only when every configured rule allows it", async () => {
  const business = await Business.create({
    owner: new mongoose.Types.ObjectId(),
    businessName: "Eligible Plumbing",
    businessType: "plumbing",
    phone: "4045559911",
    timezone: "America/New_York",
    features: { aiBookingEnabled: true },
  });

  await Promise.all([
    ServiceOffering.create({
      business: business._id,
      name: "Drain clearing",
      category: "drain",
      aiCanBook: true,
      durationMinutes: 90,
      keywords: ["clogged drain"],
    }),
    ServiceArea.create({
      business: business._id,
      type: "zip_codes",
      zipCodes: ["30303"],
    }),
    SchedulingPolicy.create({
      business: business._id,
      minimumNoticeMinutes: 0,
      allowSameDayBooking: true,
      allowAfterHoursBooking: true,
      requireAddressBeforeBooking: true,
    }),
    BusinessOperationsSettings.create({
      business: business._id,
      aiPermissions: { canBookEligibleServices: true },
    }),
    AvailabilityRule.create({
      business: business._id,
      dayOfWeek: 0,
      enabled: true,
      windows: [{ startTime: "00:00", endTime: "23:59" }],
      timezone: "America/New_York",
      capacity: 2,
    }),
  ]);

  const result = await evaluateBookingEligibility({
    business,
    serviceQuery: "clogged drain",
    zipCode: "30303",
    requestedStart: new Date(Date.now() + 48 * 60 * 60 * 1000),
    customerHasAddress: true,
  });

  expect(result.servicePerformed).toBe(true);
  expect(result.locationSupported).toBe(true);
  expect(result.durationMinutes).toBe(90);
  expect(result.mayAiBook).toBe(true);
});
