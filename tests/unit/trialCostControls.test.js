import {
  getCommunicationLimits,
  TRIAL_COMMUNICATION_LIMITS,
} from "../../src/services/communicationUsage.service.js";

describe("trial communication cost controls", () => {
  test("clamps SMS and AI budgets while trial controls are enabled", () => {
    const limits = getCommunicationLimits({
      trialCostControls: { enabled: true },
      communicationLimits: {
        smsBusinessHourly: 300,
        smsBusinessDaily: 3000,
        smsCustomerHourly: 30,
        smsCustomerDaily: 120,
        aiBusinessHourly: 150,
        aiBusinessDaily: 1000,
        aiCustomerHourly: 20,
        aiCustomerDaily: 60,
        alertThresholdPercent: 80,
      },
    });

    expect(limits.smsBusinessDaily).toBe(
      TRIAL_COMMUNICATION_LIMITS.smsBusinessDaily,
    );
    expect(limits.aiBusinessDaily).toBe(
      TRIAL_COMMUNICATION_LIMITS.aiBusinessDaily,
    );
  });

  test("leaves configured paid limits alone when trial controls are disabled", () => {
    const limits = getCommunicationLimits({
      trialCostControls: { enabled: false },
      communicationLimits: {
        smsBusinessHourly: 200,
        smsBusinessDaily: 2000,
        smsCustomerHourly: 20,
        smsCustomerDaily: 100,
        aiBusinessHourly: 100,
        aiBusinessDaily: 900,
        aiCustomerHourly: 15,
        aiCustomerDaily: 50,
        alertThresholdPercent: 80,
      },
    });

    expect(limits.smsBusinessDaily).toBe(2000);
    expect(limits.aiBusinessDaily).toBe(900);
  });
});
