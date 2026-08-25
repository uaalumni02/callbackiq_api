import {
  clearLocalScaleCache,
  getOrLoadScaleCache,
} from "../../src/services/scaleCache.service.js";

describe("scaleCache.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SCALE_CACHE_ENABLED = "true";
    delete process.env.SCALE_CACHE_REDIS_URL;
    delete process.env.REDIS_URL;
    delete process.env.SOCKET_REDIS_URL;
    clearLocalScaleCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearLocalScaleCache();
  });

  it("coalesces concurrent cache misses into one loader", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true };
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        getOrLoadScaleCache({
          key: "tenant:dashboard",
          loader,
          ttlMs: 1000,
          staleMs: 5000,
        }),
      ),
    );

    expect(calls).toBe(1);
    expect(results).toEqual(
      Array.from({ length: 20 }, () => ({ ok: true })),
    );
  });

  it("serves fresh memory entries without re-running the loader", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };

    const first = await getOrLoadScaleCache({
      key: "tenant:analytics",
      loader,
      ttlMs: 1000,
      staleMs: 5000,
    });
    const second = await getOrLoadScaleCache({
      key: "tenant:analytics",
      loader,
      ttlMs: 1000,
      staleMs: 5000,
    });

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(calls).toBe(1);
  });

  it("bypasses caching when disabled", async () => {
    process.env.SCALE_CACHE_ENABLED = "false";
    let calls = 0;
    const loader = async () => ++calls;

    await getOrLoadScaleCache({ key: "disabled", loader });
    await getOrLoadScaleCache({ key: "disabled", loader });

    expect(calls).toBe(2);
  });
});
