import {
  getPostalCodeDistanceMiles,
  haversineMiles,
  resetPostalCodeCoordinateCache,
  resolvePostalCodeCoordinates,
} from "../../src/services/location/postalCodeDistance.service.js";

describe("postalCodeDistance service", () => {
  beforeEach(() => {
    resetPostalCodeCoordinateCache();
    jest.clearAllMocks();
  });

  test("calculates haversine distance", () => {
    const miles = haversineMiles(
      { latitude: 33.749, longitude: -84.388 },
      { latitude: 34.0522, longitude: -84.5499 },
    );
    expect(miles).toBeGreaterThan(20);
    expect(miles).toBeLessThan(30);
  });

  test("returns zero for identical ZIP codes without calling a resolver", async () => {
    const resolver = jest.fn();
    await expect(
      getPostalCodeDistanceMiles({
        originPostalCode: "30318",
        destinationPostalCode: "30318-1234",
        resolver,
      }),
    ).resolves.toBe(0);
    expect(resolver).not.toHaveBeenCalled();
  });

  test("resolves and caches coordinates", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        status: "OK",
        results: [{ geometry: { location: { lat: 33.77, lng: -84.41 } } }],
      }),
    });

    const first = await resolvePostalCodeCoordinates("30318", {
      apiKey: "test",
      fetchImpl,
      now: 1000,
    });
    const second = await resolvePostalCodeCoordinates("30318", {
      apiKey: "test",
      fetchImpl,
      now: 1001,
    });

    expect(first).toEqual({ latitude: 33.77, longitude: -84.41 });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("requires provider configuration", async () => {
    await expect(
      resolvePostalCodeCoordinates("30318", { apiKey: "" }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "RADIUS_GEOCODING_NOT_CONFIGURED",
    });
  });

  test.each([
    ["ZERO_RESULTS", "POSTAL_CODE_NOT_FOUND", 422],
    ["REQUEST_DENIED", "RADIUS_GEOCODING_PROVIDER_ERROR", 502],
  ])("handles provider status %s", async (status, code, statusCode) => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status }),
    });

    await expect(
      resolvePostalCodeCoordinates("30318", {
        apiKey: "test",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code, statusCode });
  });

  test("rejects invalid ZIP values", async () => {
    await expect(
      getPostalCodeDistanceMiles({
        originPostalCode: "bad",
        destinationPostalCode: "30318",
      }),
    ).rejects.toMatchObject({ code: "INVALID_POSTAL_CODE" });
  });
});
