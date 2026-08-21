import {
  mongoDeploymentSupportsTransactions,
  registrationTransactionsRequired,
  runRegistrationTransaction,
} from "../../src/services/registrationTransaction.service.js";

const connection = (type) => ({
  client: {
    topology: {
      description: { type },
    },
  },
});

describe("registration transaction hardening", () => {
  test.each([
    ["ReplicaSetWithPrimary", true],
    ["ReplicaSetNoPrimary", true],
    ["Sharded", true],
    ["LoadBalanced", true],
    ["Single", false],
    ["Unknown", false],
    ["", false],
  ])("detects transaction capability for %s", (type, expected) => {
    expect(mongoDeploymentSupportsTransactions(connection(type))).toBe(expected);
  });

  test("requires transactions in production and staging", () => {
    expect(registrationTransactionsRequired({ NODE_ENV: "production" })).toBe(
      true,
    );
    expect(registrationTransactionsRequired({ NODE_ENV: "staging" })).toBe(
      true,
    );
    expect(registrationTransactionsRequired({ NODE_ENV: "test" })).toBe(false);
    expect(
      registrationTransactionsRequired({
        NODE_ENV: "test",
        REGISTRATION_TRANSACTION_REQUIRED: "true",
      }),
    ).toBe(true);
  });

  test("uses non-transactional fallback on standalone local/test Mongo", async () => {
    const operation = jest.fn().mockResolvedValue("ok");

    await expect(
      runRegistrationTransaction(operation, {
        connection: connection("Single"),
        env: { NODE_ENV: "test" },
      }),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledWith(null);
  });

  test("fails closed on standalone production Mongo", async () => {
    await expect(
      runRegistrationTransaction(jest.fn(), {
        connection: connection("Single"),
        env: { NODE_ENV: "production" },
      }),
    ).rejects.toThrow(/transaction-capable MongoDB deployment/);
  });

  test("uses and closes a session on replica-set Mongo", async () => {
    const operation = jest.fn().mockResolvedValue("created");
    const session = {
      withTransaction: jest.fn(async (callback) => callback()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const startSession = jest.fn().mockResolvedValue(session);

    await expect(
      runRegistrationTransaction(operation, {
        connection: connection("ReplicaSetWithPrimary"),
        startSession,
        env: { NODE_ENV: "test" },
      }),
    ).resolves.toBe("created");

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(session);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  test("closes the session when persistence throws", async () => {
    const session = {
      withTransaction: jest.fn(async (callback) => callback()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      runRegistrationTransaction(
        async () => {
          throw new Error("persistence failed");
        },
        {
          connection: connection("ReplicaSetWithPrimary"),
          startSession: jest.fn().mockResolvedValue(session),
          env: { NODE_ENV: "test" },
        },
      ),
    ).rejects.toThrow("persistence failed");

    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  test("rejects a missing operation", async () => {
    await expect(
      runRegistrationTransaction(null, {
        connection: connection("Single"),
        env: { NODE_ENV: "test" },
      }),
    ).rejects.toThrow(/must be a function/);
  });
});
