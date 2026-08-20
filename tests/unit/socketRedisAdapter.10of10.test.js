describe("Socket Redis adapter configuration", () => {
  const original = process.env;

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  test("single-instance mode remains valid when Redis is optional", async () => {
    delete process.env.SOCKET_REDIS_URL;
    delete process.env.REDIS_URL;
    delete process.env.SOCKET_REDIS_REQUIRED;

    const { initializeSocketRedisAdapter } = await import(
      "../../src/services/socketRedisAdapter.service.js"
    );

    await expect(
      initializeSocketRedisAdapter({ adapter: jest.fn() }),
    ).resolves.toEqual({ enabled: false });
  });

  test("fails closed when horizontal scaling explicitly requires Redis", async () => {
    delete process.env.SOCKET_REDIS_URL;
    delete process.env.REDIS_URL;
    process.env.SOCKET_REDIS_REQUIRED = "true";

    const { initializeSocketRedisAdapter } = await import(
      "../../src/services/socketRedisAdapter.service.js"
    );

    await expect(
      initializeSocketRedisAdapter({ adapter: jest.fn() }),
    ).rejects.toThrow(/SOCKET_REDIS_REQUIRED=true/);
  });
});
