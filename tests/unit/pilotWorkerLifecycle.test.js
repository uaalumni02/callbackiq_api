import { runPilotMaintenanceOnce } from "../../src/services/privacy/pilotMaintenance.service.js";
import { reconcileGoogleDisconnects } from "../../src/services/integrations/googleDisconnect.service.js";
import {
  startPilotPrivacyWorker,
  stopPilotPrivacyWorker,
} from "../../src/workers/pilotPrivacy.worker.js";
import {
  startIntegrationDisconnectWorker,
  stopIntegrationDisconnectWorker,
} from "../../src/workers/integrationDisconnect.worker.js";
import { logOperationalError } from "../../src/helpers/logging/safeLogger.js";
jest.mock("../../src/services/privacy/pilotMaintenance.service.js", () => ({
  runPilotMaintenanceOnce: jest.fn(),
}));
jest.mock(
  "../../src/services/integrations/googleDisconnect.service.js",
  () => ({ reconcileGoogleDisconnects: jest.fn() }),
);
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalError: jest.fn(),
}));
const workers = [
  [
    "privacy",
    startPilotPrivacyWorker,
    stopPilotPrivacyWorker,
    runPilotMaintenanceOnce,
    60000,
  ],
  [
    "disconnect",
    startIntegrationDisconnectWorker,
    stopIntegrationDisconnectWorker,
    reconcileGoogleDisconnects,
    30000,
  ],
];
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(async () => {
  await stopPilotPrivacyWorker();
  await stopIntegrationDisconnectWorker();
  jest.useRealTimers();
});
test.each(workers)(
  "M06/H10 %s starts once, retries failed sweeps, and stops future work",
  async (_name, start, stop, sweep, delay) => {
    sweep
      .mockRejectedValueOnce(
        Object.assign(new Error("synthetic offline"), { code: "OFFLINE" }),
      )
      .mockResolvedValue({});
    start();
    start();
    await jest.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logOperationalError).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(delay);
    expect(sweep).toHaveBeenCalledTimes(2);
    await stop();
    await jest.advanceTimersByTimeAsync(delay * 2);
    expect(sweep).toHaveBeenCalledTimes(2);
  },
);
test.each(workers)(
  "M06/H10 %s drains a pending sweep and never starts another",
  async (_name, start, stop, sweep, delay) => {
    let finish;
    sweep.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    start();
    const draining = stop();
    finish({});
    await draining;
    await jest.advanceTimersByTimeAsync(delay * 2);
    expect(sweep).toHaveBeenCalledTimes(1);
  },
);
