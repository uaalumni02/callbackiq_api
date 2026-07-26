import "dotenv/config";

const baseUrl = String(
  process.env.SMOKE_TEST_API_URL || process.env.PUBLIC_API_URL || "",
).replace(/\/+$/, "");

if (!baseUrl) {
  console.error("SMOKE_TEST_API_URL or PUBLIC_API_URL is required.");
  process.exit(1);
}

const timeoutMs = Number(process.env.SMOKE_TEST_TIMEOUT_MS || 15000);

const request = async (path, expectedStatus = 200) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        "X-Smoke-Test": "callbackiq-phase1",
      },
      signal: controller.signal,
    });

    const body = await response.text();

    if (response.status !== expectedStatus) {
      throw new Error(
        `${path} returned ${response.status}; expected ${expectedStatus}. Body: ${body.slice(
          0,
          500,
        )}`,
      );
    }

    console.log(`PASS ${path} (${response.status})`);
  } finally {
    clearTimeout(timeout);
  }
};

await request("/api/health/live");
await request("/api/health/ready");

console.log("CallBackIQ deployment smoke test passed.");
