const base = String(
  process.env.CALLBACKIQ_HEALTH_URL || process.argv[2] || "",
).replace(/\/+$/, "");

if (!base) {
  console.error(
    "CALLBACKIQ_HEALTH_URL (or argv[2]) is required, e.g. https://api.example.com/api/health",
  );
  process.exit(2);
}

const timeoutMs = Number.parseInt(
  process.env.HEALTH_PROBE_TIMEOUT_MS || "8000",
  10,
);
const latencyWarnMs = Number.parseInt(
  process.env.HEALTH_PROBE_LATENCY_WARN_MS || "2000",
  10,
);

const endpoints = ["live", "ready"];
let failed = false;

for (const endpoint of endpoints) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(`${base}/${endpoint}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "CallBackIQ-Health-Probe/1.0",
      },
      redirect: "error",
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const body = await response.text();
    const ok = response.ok;

    console.log(
      JSON.stringify({
        endpoint,
        ok,
        status: response.status,
        latencyMs,
        slow: latencyMs > latencyWarnMs,
        body: body.slice(0, 500),
      }),
    );

    if (!ok) failed = true;
  } catch (error) {
    failed = true;
    console.error(
      JSON.stringify({
        endpoint,
        ok: false,
        latencyMs: Date.now() - started,
        error: error?.name || "Error",
        message: error?.message || String(error),
      }),
    );
  } finally {
    clearTimeout(timeout);
  }
}

process.exit(failed ? 1 : 0);
