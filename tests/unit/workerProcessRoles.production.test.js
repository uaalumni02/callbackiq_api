describe("production PROCESS_ROLE boot matrix", () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.CALLBACKIQ_WORKER_BOOT_TEST = "true";
    process.env.NODE_ENV = "test";
    process.env.MONGODB_URI =
      "mongodb://127.0.0.1:27017/callbackiq_role_boot_test";
    process.env.MONGO_URL = process.env.MONGODB_URI;
    process.env.JWT_SECRET =
      "callbackiq-role-boot-test-secret-12345678901234567890";
    process.env.CLIENT_URL = "http://localhost:3001";
    process.env.PUBLIC_API_URL = "https://ci-api.callbackiq.com";
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test("server production roles are accepted", async () => {
    const { assertServerProcessRole } = await import(
      "../../src/config/runtime-environment.js"
    );

    expect(assertServerProcessRole({ PROCESS_ROLE: "api" })).toBe("api");
    expect(assertServerProcessRole({ PROCESS_ROLE: "all" })).toBe("all");
  });

  test("standalone worker registry includes voice usage reconciliation", async () => {
    const { roleMap } = await import("../../src/worker.js");
    expect(roleMap.worker.map(([name]) => name)).toContain("voice-usage");
  });

  test.each([
    "worker",
    "worker-sms",
    "worker-automation",
    "worker-lifecycle",
    "worker-a2p",
    "worker-maintenance",
  ])("boots %s without touching a real database or provider", async (role) => {
    process.env.PROCESS_ROLE = role;
    const { roleMap, startWorkerProcess } = await import("../../src/worker.js");

    const starts = roleMap[role].map(([name]) => [
      name,
      jest.fn(),
      jest.fn(),
    ]);
    const connect = jest.fn().mockResolvedValue(undefined);

    await expect(
      startWorkerProcess({
        connect,
        workerRoles: { [role]: starts },
      }),
    ).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(1);
    for (const [, start] of starts) {
      expect(start).toHaveBeenCalledTimes(1);
    }
  });
  test("covers standalone worker default dependencies without external I/O", async () => {
    const previousRole = process.env.PROCESS_ROLE;
    const previousBootTest = process.env.CALLBACKIQ_WORKER_BOOT_TEST;
    const previousExitCode = process.exitCode;

    const connect = jest.fn().mockResolvedValue(undefined);
    const startAutomation = jest.fn();
    const stopAutomation = jest.fn();

    try {
      process.env.PROCESS_ROLE = "worker-automation";
      process.env.CALLBACKIQ_WORKER_BOOT_TEST = "true";

      jest.resetModules();
      jest.doMock("../../src/db/connection.js", () => ({
        __esModule: true,
        default: connect,
      }));
      jest.doMock("../../src/workers/automation.worker.js", () => ({
        __esModule: true,
        startAutomationWorker: startAutomation,
        stopAutomationWorker: stopAutomation,
      }));

      const { startWorkerProcess } = await import("../../src/worker.js");

      await expect(
        startWorkerProcess(),
      ).resolves.toBeUndefined();

      expect(connect).toHaveBeenCalledTimes(1);
      expect(startAutomation).toHaveBeenCalledTimes(1);
    } finally {
      if (previousRole === undefined) {
        delete process.env.PROCESS_ROLE;
      } else {
        process.env.PROCESS_ROLE = previousRole;
      }

      if (previousBootTest === undefined) {
        delete process.env.CALLBACKIQ_WORKER_BOOT_TEST;
      } else {
        process.env.CALLBACKIQ_WORKER_BOOT_TEST = previousBootTest;
      }

      process.exitCode = previousExitCode;
      jest.dontMock("../../src/db/connection.js");
      jest.dontMock("../../src/workers/automation.worker.js");
      jest.resetModules();
    }
  });

  test("covers standalone worker auto-start and process failure handlers safely", async () => {
    const previousRole = process.env.PROCESS_ROLE;
    const previousBootTest = process.env.CALLBACKIQ_WORKER_BOOT_TEST;
    const previousDrainGrace = process.env.WORKER_DRAIN_GRACE_MS;
    const previousExitCode = process.exitCode;

    const watchedEvents = [
      "SIGTERM",
      "SIGINT",
      "unhandledRejection",
      "uncaughtException",
    ];

    const originalListeners = Object.fromEntries(
      watchedEvents.map((event) => [
        event,
        new Set(process.listeners(event)),
      ]),
    );

    const startupError = new Error(
      "synthetic worker bootstrap failure",
    );
    const connect = jest
      .fn()
      .mockRejectedValue(startupError);
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      process.env.PROCESS_ROLE = "worker-automation";
      process.env.CALLBACKIQ_WORKER_BOOT_TEST = "false";
      process.env.WORKER_DRAIN_GRACE_MS = "0";

      jest.resetModules();
      jest.doMock("../../src/db/connection.js", () => ({
        __esModule: true,
        default: connect,
      }));

      await import("../../src/worker.js");

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();

      expect(connect).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "Worker startup failed:",
        startupError,
      );

      const addedListeners = Object.fromEntries(
        watchedEvents.map((event) => [
          event,
          process
            .listeners(event)
            .filter(
              (listener) =>
                !originalListeners[event].has(listener),
            ),
        ]),
      );

      expect(
        addedListeners.SIGTERM.length,
      ).toBeGreaterThan(0);
      expect(
        addedListeners.SIGINT.length,
      ).toBeGreaterThan(0);
      expect(
        addedListeners.unhandledRejection.length,
      ).toBeGreaterThan(0);
      expect(
        addedListeners.uncaughtException.length,
      ).toBeGreaterThan(0);

      addedListeners.unhandledRejection.at(-1)(
        new Error("synthetic unhandled rejection"),
      );

      addedListeners.uncaughtException.at(-1)(
        new Error("synthetic uncaught exception"),
      );

      addedListeners.SIGTERM.at(-1)();
      addedListeners.SIGINT.at(-1)();

      await Promise.resolve();

      expect(consoleError).toHaveBeenCalledWith(
        "Unhandled worker rejection:",
        expect.any(Error),
      );

      expect(consoleError).toHaveBeenCalledWith(
        "Uncaught worker exception:",
        expect.any(Error),
      );
    } finally {
      for (const event of watchedEvents) {
        for (const listener of process.listeners(event)) {
          if (!originalListeners[event].has(listener)) {
            process.removeListener(event, listener);
          }
        }
      }

      if (previousRole === undefined) {
        delete process.env.PROCESS_ROLE;
      } else {
        process.env.PROCESS_ROLE = previousRole;
      }

      if (previousBootTest === undefined) {
        delete process.env.CALLBACKIQ_WORKER_BOOT_TEST;
      } else {
        process.env.CALLBACKIQ_WORKER_BOOT_TEST =
          previousBootTest;
      }

      if (previousDrainGrace === undefined) {
        delete process.env.WORKER_DRAIN_GRACE_MS;
      } else {
        process.env.WORKER_DRAIN_GRACE_MS =
          previousDrainGrace;
      }

      process.exitCode = previousExitCode;
      consoleError.mockRestore();
      jest.dontMock("../../src/db/connection.js");
      jest.resetModules();
    }
  });

});
