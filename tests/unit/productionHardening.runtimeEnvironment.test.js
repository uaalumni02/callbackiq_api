import {
  assertRealtimeScalingConfig,
  assertServerProcessRole,
  getCanonicalPublicApiUrl,
  getMongoUrl,
  getProcessRole,
  normalizeRuntimeEnvironment,
  resolveTrustProxy,
  shouldRunEmbeddedWorkers,
} from "../../src/config/runtime-environment.js";

describe("production hardening runtime environment", () => {
  test("normalizes legacy Mongo and API URL aliases", () => {
    const env = {
      NODE_ENV: "production",
      MONGO_URL: "mongodb://example.invalid/test",
      API_PUBLIC_URL: "https://api.example.com",
    };

    const result = normalizeRuntimeEnvironment(env);

    expect(result.mongoUrl).toBe("mongodb://example.invalid/test");
    expect(env.MONGODB_URI).toBe("mongodb://example.invalid/test");
    expect(env.PUBLIC_API_URL).toBe("https://api.example.com");
    expect(env.TWILIO_WEBHOOK_BASE_URL).toBe("https://api.example.com");
    expect(getMongoUrl(env)).toBe("mongodb://example.invalid/test");
    expect(getCanonicalPublicApiUrl(env)).toBe("https://api.example.com");
  });

  test("does not override explicit provider callback URL", () => {
    const env = {
      PUBLIC_API_URL: "https://api.example.com",
      TWILIO_WEBHOOK_BASE_URL: "https://hooks.example.com",
    };
    normalizeRuntimeEnvironment(env);
    expect(env.TWILIO_WEBHOOK_BASE_URL).toBe("https://hooks.example.com");
  });

  test.each([
    [undefined, 1],
    ["true", true],
    ["false", false],
    ["2", 2],
    ["loopback, linklocal", "loopback, linklocal"],
  ])("resolves trust proxy %p", (input, expected) => {
    expect(resolveTrustProxy(input, 1)).toEqual(expected);
  });

  test("defaults to embedded workers for backward compatibility", () => {
    expect(getProcessRole({})).toBe("all");
    expect(shouldRunEmbeddedWorkers({})).toBe(true);
    expect(shouldRunEmbeddedWorkers({ PROCESS_ROLE: "api" })).toBe(false);
  });

  test("rejects worker-only role in HTTP entrypoint", () => {
    expect(() =>
      assertServerProcessRole({ PROCESS_ROLE: "worker-sms" }),
    ).toThrow(/worker-only/);
  });

  test("requires Redis for multi-instance production API", () => {
    expect(() =>
      assertRealtimeScalingConfig({
        NODE_ENV: "production",
        API_INSTANCE_COUNT: "2",
      }),
    ).toThrow(/Redis is required/);

    const env = {
      NODE_ENV: "production",
      API_INSTANCE_COUNT: "2",
      REDIS_URL: "redis://example",
    };
    expect(assertRealtimeScalingConfig(env)).toEqual({
      required: true,
      instanceCount: 2,
    });
    expect(env.SOCKET_REDIS_REQUIRED).toBe("true");
  });

  test("single instance does not require Redis unless explicitly required", () => {
    expect(
      assertRealtimeScalingConfig({
        NODE_ENV: "production",
        API_INSTANCE_COUNT: "1",
      }),
    ).toEqual({ required: false, instanceCount: 1 });

    expect(() =>
      assertRealtimeScalingConfig({
        SOCKET_REDIS_REQUIRED: "true",
      }),
    ).toThrow(/Redis is required/);
  });
});
