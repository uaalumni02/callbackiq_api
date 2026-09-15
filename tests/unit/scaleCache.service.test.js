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

it('bounds database loader fan-out across different cold keys', async () => {
  const env = { ...process.env };
  process.env.SCALE_CACHE_ENABLED = 'true'; process.env.SCALE_CACHE_MAX_LOADERS = '2';
  delete process.env.REDIS_URL; delete process.env.SOCKET_REDIS_URL; delete process.env.SCALE_CACHE_REDIS_URL;
  clearLocalScaleCache();
  let release; const gate = new Promise(resolve => { release = resolve; }); let started = 0;
  try {
    const requests = Array.from({ length: 6 }, (_, i) => getOrLoadScaleCache({ key: `fanout:${i}`, loader: async () => { started++; await gate; return i; } }));
    const settled = Promise.allSettled(requests);
    await new Promise(resolve => setImmediate(resolve)); expect(started).toBe(2); release();
    const results = await settled;
    expect(results.filter(x => x.status === 'rejected')).toHaveLength(4);
  } finally { release(); clearLocalScaleCache(); process.env = env; }
});
