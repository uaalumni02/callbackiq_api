const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EARTH_RADIUS_MILES = 3958.7613;

const coordinateCache = new Map();

const createServiceError = (message, statusCode, code, cause = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

const normalizePostalCode = (value) => {
  const postalCode = String(value || "").trim();

  if (!ZIP_PATTERN.test(postalCode)) {
    throw createServiceError(
      "postalCode must be a valid US ZIP code.",
      400,
      "INVALID_POSTAL_CODE",
    );
  }

  return postalCode.slice(0, 5);
};

const toRadians = (degrees) => (Number(degrees) * Math.PI) / 180;

export const haversineMiles = (first, second) => {
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getCachedCoordinates = (postalCode, now) => {
  const cached = coordinateCache.get(postalCode);

  if (!cached || cached.expiresAt <= now) {
    coordinateCache.delete(postalCode);
    return null;
  }

  return cached.coordinates;
};

const cacheCoordinates = (postalCode, coordinates, now, cacheTtlMs) => {
  coordinateCache.set(postalCode, {
    coordinates,
    expiresAt: now + cacheTtlMs,
  });
};

export const resolvePostalCodeCoordinates = async (
  postalCode,
  {
    apiKey = process.env.GOOGLE_MAPS_GEOCODING_API_KEY,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    now = Date.now(),
  } = {},
) => {
  const normalizedPostalCode = normalizePostalCode(postalCode);
  const cached = getCachedCoordinates(normalizedPostalCode, now);

  if (cached) return cached;

  if (!apiKey) {
    throw createServiceError(
      "Radius service areas require GOOGLE_MAPS_GEOCODING_API_KEY.",
      503,
      "RADIUS_GEOCODING_NOT_CONFIGURED",
    );
  }

  if (typeof fetchImpl !== "function") {
    throw createServiceError(
      "The geocoding client is unavailable.",
      503,
      "RADIUS_GEOCODING_UNAVAILABLE",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 0, 1));
  timeout.unref?.();

  try {
    const params = new URLSearchParams({
      components: `postal_code:${normalizedPostalCode}|country:US`,
      key: apiKey,
    });
    const response = await fetchImpl(
      `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
      { signal: controller.signal },
    );

    if (!response?.ok) {
      throw createServiceError(
        `The geocoding provider returned HTTP ${response?.status || "unknown"}.`,
        502,
        "RADIUS_GEOCODING_PROVIDER_ERROR",
      );
    }

    const payload = await response.json();

    if (payload?.status === "ZERO_RESULTS") {
      throw createServiceError(
        `No coordinates were found for ZIP code ${normalizedPostalCode}.`,
        422,
        "POSTAL_CODE_NOT_FOUND",
      );
    }

    if (payload?.status !== "OK") {
      throw createServiceError(
        payload?.error_message || `The geocoding provider returned ${payload?.status || "an invalid response"}.`,
        502,
        "RADIUS_GEOCODING_PROVIDER_ERROR",
      );
    }

    const location = payload?.results?.[0]?.geometry?.location;
    const latitude = Number(location?.lat);
    const longitude = Number(location?.lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw createServiceError(
        "The geocoding provider did not return usable coordinates.",
        502,
        "RADIUS_GEOCODING_INVALID_RESPONSE",
      );
    }

    const coordinates = { latitude, longitude };
    cacheCoordinates(normalizedPostalCode, coordinates, now, cacheTtlMs);
    return coordinates;
  } catch (error) {
    if (error?.code) throw error;

    if (error?.name === "AbortError") {
      throw createServiceError(
        "The geocoding request timed out.",
        504,
        "RADIUS_GEOCODING_TIMEOUT",
        error,
      );
    }

    throw createServiceError(
      "The geocoding provider could not be reached.",
      502,
      "RADIUS_GEOCODING_UNAVAILABLE",
      error,
    );
  } finally {
    clearTimeout(timeout);
  }
};

export const getPostalCodeDistanceMiles = async ({
  originPostalCode,
  destinationPostalCode,
  resolver = resolvePostalCodeCoordinates,
  resolverOptions,
}) => {
  const origin = normalizePostalCode(originPostalCode);
  const destination = normalizePostalCode(destinationPostalCode);

  if (origin === destination) return 0;

  const [originCoordinates, destinationCoordinates] = await Promise.all([
    resolver(origin, resolverOptions),
    resolver(destination, resolverOptions),
  ]);

  return haversineMiles(originCoordinates, destinationCoordinates);
};

export const resetPostalCodeCoordinateCache = () => {
  coordinateCache.clear();
};

export default getPostalCodeDistanceMiles;
