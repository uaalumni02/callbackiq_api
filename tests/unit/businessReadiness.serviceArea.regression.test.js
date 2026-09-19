import AvailabilityRule from "../../src/models/availabilityRule.js";
jest.mock("../../src/models/availabilityRule.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import Business from "../../src/models/business.js";
jest.mock("../../src/models/business.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import BusinessOperationsSettings from "../../src/models/businessOperationsSettings.js";
jest.mock("../../src/models/businessOperationsSettings.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import IntegrationConnection from "../../src/models/integrationConnection.js";
jest.mock("../../src/models/integrationConnection.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import SchedulingPolicy from "../../src/models/schedulingPolicy.js";
jest.mock("../../src/models/schedulingPolicy.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import ServiceArea from "../../src/models/serviceArea.js";
jest.mock("../../src/models/serviceArea.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import ServiceOffering from "../../src/models/serviceOffering.js";
jest.mock("../../src/models/serviceOffering.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import Subscription from "../../src/models/subscription.js";
jest.mock("../../src/models/subscription.js", () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() } }));
import { buildBusinessReadiness } from "../../src/services/businessReadiness.service.js";

describe('business readiness respects explicit service-area configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const query = value => ({ lean: jest.fn().mockResolvedValue(value) });
    Subscription.findOne.mockReturnValue(query({ isActive: true, status: 'active', stripeSubscriptionId: 'sub_test' }));
    ServiceOffering.find.mockReturnValue(query([{ durationMinutes: 60 }]));
    AvailabilityRule.find.mockReturnValue(query([{ enabled: true, windows: [{ allDay: true }] }]));
    SchedulingPolicy.findOne.mockReturnValue(query({ minimumNoticeMinutes: 1440 }));
    BusinessOperationsSettings.findOne.mockReturnValue(query({ aiPermissions: { canBookEligibleServices: true } }));
    IntegrationConnection.find.mockReturnValue(query([]));
  });
  test.each([
    ['unrestricted', { type: 'unrestricted' }, true],
    ['configured ZIP codes', { type: 'zip_codes', zipCodes: ['30318'] }, true],
    ['empty ZIP codes', { type: 'zip_codes', zipCodes: [] }, false],
    ['configured radius', { type: 'radius', centerPostalCode: '30318', radiusMiles: 20 }, true],
    ['zero radius', { type: 'radius', centerPostalCode: '30318', radiusMiles: 0 }, false],
    ['missing configuration', null, false],
  ])('%s produces the correct booking readiness', async (_label, area, ready) => {
    ServiceArea.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(area) });
    const result = await buildBusinessReadiness({ _id: 'b1', features: { aiBookingEnabled: true, calendarProvider: 'internal' } }, { persist: false });
    expect(result.checks.serviceAreaConfigured).toBe(ready);
    expect(result.states.bookingConfigurationReady).toBe(ready);
    expect(result.states.bookingReady).toBe(ready);
    expect(result.missingRequirements.booking.some(item => item.code === 'service_area_required')).toBe(!ready);
    expect(Business.updateOne).not.toHaveBeenCalled();
    expect(ServiceArea.findOne).toHaveBeenCalledWith({ business: 'b1' });
  });
});
