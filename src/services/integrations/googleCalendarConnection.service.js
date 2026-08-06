import crypto from "crypto";

import Business from "../../models/business.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import { decryptSecret, encryptSecret } from "./tokenEncryption.service.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export const GOOGLE_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
]);

const createError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const readEnvironment = (...names) => {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
};

export const getGoogleOAuthConfig = () => {
  const clientId = readEnvironment(
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CLIENT_ID",
  );
  const clientSecret = readEnvironment(
    "GOOGLE_CALENDAR_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET",
  );
  const redirectUri = readEnvironment(
    "GOOGLE_CALENDAR_REDIRECT_URI",
    "GOOGLE_REDIRECT_URI",
  );
  const stateSecret = readEnvironment("OAUTH_STATE_SECRET");

  if (!clientId || !clientSecret || !redirectUri || stateSecret.length < 24) {
    throw createError(
      "Google Calendar OAuth is not configured. Set GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REDIRECT_URI, and an OAUTH_STATE_SECRET of at least 24 characters.",
      503,
      "GOOGLE_OAUTH_NOT_CONFIGURED",
    );
  }

  return { clientId, clientSecret, redirectUri, stateSecret };
};

const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

export const signGoogleOAuthState = (payload, secret) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
};

export const verifyGoogleOAuthState = (state, secret, now = Date.now()) => {
  const [encoded, signature] = String(state || "").split(".");

  if (!encoded || !signature) {
    throw createError("Invalid Google OAuth state.", 400, "GOOGLE_OAUTH_STATE_INVALID");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw createError(
      "Google OAuth state signature verification failed.",
      400,
      "GOOGLE_OAUTH_STATE_INVALID",
    );
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw createError("Invalid Google OAuth state.", 400, "GOOGLE_OAUTH_STATE_INVALID");
  }

  if (
    !payload.businessId ||
    !payload.nonce ||
    !payload.exp ||
    now > Number(payload.exp)
  ) {
    throw createError(
      "Google OAuth state has expired.",
      400,
      "GOOGLE_OAUTH_STATE_EXPIRED",
    );
  }

  return payload;
};

const parseProviderResponse = async (response, context) => {
  if (!response) {
    throw createError(
      `${context} did not return a response.`,
      502,
      "GOOGLE_PROVIDER_NO_RESPONSE",
    );
  }

  let payload = {};
  if (response.status !== 204) {
    // Fetch test doubles and some intermediaries omit headers/text. Prefer JSON
    // whenever available, then fall back to text without assuming either method.
    if (typeof response.json === "function") {
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
    }
    if (
      (!payload || Object.keys(payload).length === 0) &&
      typeof response.text === "function"
    ) {
      try {
        const text = await response.text();
        if (text) payload = { message: text };
      } catch {
        // The provider status below still supplies a useful fallback message.
      }
    }
  }

  if (!response.ok) {
    const providerCode =
      payload?.error?.status || payload?.error || payload?.code || "";
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.message ||
      `${context} failed with status ${response.status}`;
    const error = createError(
      String(message),
      response.status >= 500 ? 502 : response.status || 400,
      providerCode ? String(providerCode) : "GOOGLE_PROVIDER_ERROR",
    );
    error.providerStatus = response.status;
    error.providerPayload = payload;
    throw error;
  }

  return payload;
};


const resolveSelectedQuery = async (query, selection) => {
  if (query && typeof query.select === "function") {
    return query.select(selection);
  }
  return query;
};

const getGoogleAccount = async (accessToken) => {
  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const account = await parseProviderResponse(response, "Google account lookup");
    return {
      id: String(account.id || ""),
      email: String(account.email || "").trim().toLowerCase(),
    };
  } catch {
    /* Calendar authorization remains usable if the optional identity lookup fails. */
    return { id: "", email: "" };
  }
};

const setConnectionHealthy = (connection) => {
  connection.status = "connected";
  connection.lastSuccessfulSyncAt = new Date();
  connection.lastErrorAt = null;
  connection.lastErrorCode = "";
  connection.lastErrorMessage = "";
};

const markReconnectRequired = async (connection, error) => {
  connection.status = "reconnect_required";
  connection.lastErrorAt = new Date();
  connection.lastErrorCode =
    error?.code || error?.providerPayload?.error || "GOOGLE_AUTH_REVOKED";
  connection.lastErrorMessage =
    error?.message || "Google Calendar authorization must be renewed.";
  await connection.save();
};

export const buildGoogleAuthorizationUrl = async (businessId, ownerId = "") => {
  const { clientId, redirectUri, stateSecret } = getGoogleOAuthConfig();
  const nonce = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + 10 * 60_000;
  const state = signGoogleOAuthState(
    {
      businessId: String(businessId),
      ownerId: ownerId ? String(ownerId) : "",
      nonce,
      exp: expiresAt,
    },
    stateSecret,
  );

  await IntegrationConnection.findOneAndUpdate(
    { business: businessId, provider: "google_calendar" },
    {
      $set: {
        oauthStateHash: hashValue(state),
        oauthStateExpiresAt: new Date(expiresAt),
        status: "disconnected",
        lastErrorAt: null,
        lastErrorCode: "",
        lastErrorMessage: "",
      },
      $setOnInsert: {
        metadata: {},
      },
    },
    { upsert: true, new: true },
  );

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);

  return url.toString();
};

export const exchangeGoogleAuthorizationCode = async ({ code, state }) => {
  const { clientId, clientSecret, redirectUri, stateSecret } =
    getGoogleOAuthConfig();
  const payload = verifyGoogleOAuthState(state, stateSecret);

  if (payload.ownerId) {
    const businessQuery = Business.findOne({
      _id: payload.businessId,
      owner: payload.ownerId,
    });
    const business =
      businessQuery && typeof businessQuery.select === "function"
        ? await businessQuery.select("_id")
        : await businessQuery;
    if (!business) {
      throw createError(
        "The Google connection no longer belongs to the initiating business owner.",
        403,
        "GOOGLE_OAUTH_OWNER_MISMATCH",
      );
    }
  }

  const secretSelection =
    "+accessTokenEncrypted +refreshTokenEncrypted +oauthStateHash +oauthStateExpiresAt";
  const pending = await resolveSelectedQuery(
    IntegrationConnection.findOne({
      business: payload.businessId,
      provider: "google_calendar",
    }),
    secretSelection,
  );

  const expectedStateHash = hashValue(state);
  if (
    !pending ||
    pending.oauthStateHash !== expectedStateHash ||
    !pending.oauthStateExpiresAt ||
    new Date(pending.oauthStateExpiresAt) <= new Date()
  ) {
    throw createError(
      "Google OAuth state does not match an active connection request or was already used.",
      400,
      "GOOGLE_OAUTH_STATE_REPLAYED",
    );
  }

  // Atomically consume the state. Reading first preserves compatibility with
  // existing model mocks; the conditional update still prevents replay races.
  const consumed = await resolveSelectedQuery(
    IntegrationConnection.findOneAndUpdate(
      {
        business: payload.businessId,
        provider: "google_calendar",
        oauthStateHash: expectedStateHash,
        oauthStateExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          oauthStateHash: "",
          oauthStateExpiresAt: null,
        },
      },
      { new: true },
    ),
    secretSelection,
  );

  if (!consumed) {
    throw createError(
      "Google OAuth state does not match an active connection request or was already used.",
      400,
      "GOOGLE_OAUTH_STATE_REPLAYED",
    );
  }

  const connection = pending;
  connection.oauthStateHash = "";
  connection.oauthStateExpiresAt = null;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await parseProviderResponse(response, "Google token exchange");

  if (!tokens.access_token) {
    throw createError(
      "Google did not return an access token.",
      502,
      "GOOGLE_ACCESS_TOKEN_MISSING",
    );
  }

  const account = await getGoogleAccount(tokens.access_token);
  connection.accessTokenEncrypted = encryptSecret(tokens.access_token);
  if (tokens.refresh_token) {
    connection.refreshTokenEncrypted = encryptSecret(tokens.refresh_token);
  }
  if (!connection.refreshTokenEncrypted) {
    throw createError(
      "Google did not return a refresh token. Reconnect and approve offline access.",
      409,
      "GOOGLE_REFRESH_TOKEN_MISSING",
    );
  }

  connection.tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
    : null;
  const fallbackScopes = [
    ...GOOGLE_SCOPES,
    // Preserve compatibility with previously connected accounts whose stored
    // scope metadata included the legacy read-only Calendar scope. It is not
    // requested by the new OAuth URL.
    "https://www.googleapis.com/auth/calendar.readonly",
  ];
  const grantedScopes = String(tokens.scope || fallbackScopes.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  connection.scopes = grantedScopes;
  connection.grantedScopes = grantedScopes;
  if (account.id) connection.providerAccountId = account.id;
  if (account.email) connection.providerAccountEmail = account.email;
  connection.connectedAt = new Date();
  connection.disconnectedAt = null;
  setConnectionHealthy(connection);
  await connection.save();

  return { businessId: payload.businessId, connection };
};

export const getGoogleConnection = async (
  businessId,
  includeSecrets = false,
) => {
  let query = IntegrationConnection.findOne({
    business: businessId,
    provider: "google_calendar",
  });

  if (includeSecrets) {
    query = query.select(
      "+accessTokenEncrypted +refreshTokenEncrypted",
    );
  }

  return query;
};

export const getGoogleAccessToken = async (businessId) => {
  const { clientId, clientSecret } = getGoogleOAuthConfig();
  const connection = await getGoogleConnection(businessId, true);

  if (!connection || connection.status === "disconnected") {
    throw createError(
      "Google Calendar is not connected.",
      409,
      "GOOGLE_NOT_CONNECTED",
    );
  }

  if (connection.status === "reconnect_required") {
    throw createError(
      "Google Calendar must be reconnected.",
      409,
      "GOOGLE_RECONNECT_REQUIRED",
    );
  }
  if (connection.status === "expired") {
    throw createError(
      "Google Calendar authorization has expired.",
      409,
      "GOOGLE_AUTH_EXPIRED",
    );
  }

  const hasUsableAccessToken =
    connection.accessTokenEncrypted &&
    (!connection.tokenExpiresAt ||
      connection.tokenExpiresAt > new Date(Date.now() + 60_000));

  if (hasUsableAccessToken) {
    return {
      token: decryptSecret(connection.accessTokenEncrypted),
      connection,
    };
  }

  if (!connection.refreshTokenEncrypted) {
    const error = createError(
      "Google Calendar authorization has expired because no refresh token is available.",
      409,
      "GOOGLE_AUTH_EXPIRED",
    );
    connection.status = "expired";
    connection.lastErrorAt = new Date();
    connection.lastErrorCode = error.code;
    connection.lastErrorMessage = error.message;
    await connection.save();
    throw error;
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptSecret(connection.refreshTokenEncrypted),
      grant_type: "refresh_token",
    }),
  });

  try {
    const tokens = await parseProviderResponse(response, "Google token refresh");
    if (!tokens.access_token) {
      throw createError(
        "Google did not return a refreshed access token.",
        502,
        "GOOGLE_ACCESS_TOKEN_MISSING",
      );
    }
    connection.accessTokenEncrypted = encryptSecret(tokens.access_token);
    if (tokens.refresh_token) {
      connection.refreshTokenEncrypted = encryptSecret(tokens.refresh_token);
    }
    connection.tokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
      : null;
    setConnectionHealthy(connection);
    await connection.save();
    return { token: tokens.access_token, connection };
  } catch (error) {
    const revoked =
      response.status === 400 ||
      response.status === 401 ||
      /invalid_grant|revoked|expired/i.test(
        `${error.message || ""} ${JSON.stringify(error.providerPayload || {})}`,
      );

    if (revoked) {
      await markReconnectRequired(connection, error);
      error.code = "GOOGLE_RECONNECT_REQUIRED";
      error.statusCode = 409;
    } else {
      connection.status = "error";
      connection.lastErrorAt = new Date();
      connection.lastErrorCode = error.code || "GOOGLE_TOKEN_REFRESH_FAILED";
      connection.lastErrorMessage = error.message;
      await connection.save();
    }
    throw error;
  }
};

export const googleApiRequest = async ({
  businessId,
  path,
  method = "GET",
  body,
  allowStatuses = [],
}) => {
  const { token, connection } = await getGoogleAccessToken(businessId);
  const response = await fetch(`${GOOGLE_CALENDAR_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    const allowed = Array.isArray(allowStatuses) && allowStatuses.includes(response.status);
    const payload = allowed
      ? { __providerStatus: response.status }
      : await parseProviderResponse(
          response,
          `Google Calendar ${method} ${path}`,
        );
    await IntegrationConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          status: "connected",
          lastSuccessfulSyncAt: new Date(),
          lastErrorAt: null,
          lastErrorCode: "",
          lastErrorMessage: "",
        },
      },
    );
    return payload;
  } catch (error) {
    const authorizationExpired = response.status === 401;
    await IntegrationConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          status: authorizationExpired ? "expired" : "error",
          lastErrorAt: new Date(),
          lastErrorCode: authorizationExpired
            ? "GOOGLE_AUTH_EXPIRED"
            : error.code || "GOOGLE_API_ERROR",
          lastErrorMessage: error.message,
        },
      },
    );
    if (authorizationExpired) {
      error.code = "GOOGLE_AUTH_EXPIRED";
      error.statusCode = 409;
    }
    throw error;
  }
};

export const listGoogleCalendars = async (
  businessId,
  includeCapabilities = false,
) => {
  const payload = await googleApiRequest({
    businessId,
    path: "/users/me/calendarList?minAccessRole=freeBusyReader&showHidden=false&maxResults=250",
  });

  return (payload.items || []).map((calendar) => {
    const accessRole = calendar.accessRole || "reader";
    const canWrite = calendar.accessRole
      ? ["writer", "owner"].includes(accessRole)
      : true;
    const canReadAvailability = calendar.accessRole
      ? ["freeBusyReader", "reader", "writer", "owner"].includes(accessRole)
      : true;
    const base = {
      id: calendar.id,
      summary: calendar.summary || calendar.id,
      primary: Boolean(calendar.primary),
      selected: Boolean(calendar.selected),
      accessRole,
      timeZone: calendar.timeZone || "",
    };

    return includeCapabilities
      ? {
          ...base,
          description: calendar.description || "",
          writable: canWrite,
          canWrite,
          canReadAvailability,
        }
      : base;
  });
};

const uniqueIds = (values) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ),
];

const normalizedOptionalEmail = (value) => {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError(
      "defaultAttendeeEmail must be a valid email address.",
      400,
      "GOOGLE_ATTENDEE_EMAIL_INVALID",
    );
  }
  return email;
};

const normalizedReminderHours = (values) => {
  const source = Array.isArray(values) ? values : [24, 2];
  const hours = [
    ...new Set(
      source
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= 168),
    ),
  ].sort((first, second) => second - first);
  return hours.length ? hours : [24, 2];
};

export const selectGoogleCalendar = async ({
  businessId,
  calendarId,
  bookingCalendarId,
  availabilityCalendarIds,
  syncEnabled = true,
  watchEnabled = true,
  sendUpdates = "all",
  defaultAttendeeEmail = "",
  includeEstimatedValue = false,
  customerRemindersEnabled = true,
  reminderHours = [24, 2],
  postAppointmentFollowUpEnabled = true,
  postAppointmentFollowUpDelayHours = 2,
  googleChangeApprovalRequired = true,
}) => {
  const selectedBookingId = String(
    bookingCalendarId || calendarId || "",
  ).trim();

  if (!selectedBookingId) {
    throw createError(
      "Choose a Google booking calendar.",
      400,
      "GOOGLE_BOOKING_CALENDAR_REQUIRED",
    );
  }

  const calendars = await listGoogleCalendars(businessId, true);
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const bookingCalendar = byId.get(selectedBookingId);

  if (!bookingCalendar) {
    throw createError(
      "The selected Google booking calendar was not found.",
      404,
      "GOOGLE_BOOKING_CALENDAR_NOT_FOUND",
    );
  }
  if (!bookingCalendar.canWrite) {
    throw createError(
      "The selected Google booking calendar is not writable.",
      400,
      "GOOGLE_BOOKING_CALENDAR_NOT_WRITABLE",
    );
  }

  const blockers = uniqueIds(
    availabilityCalendarIds?.length
      ? availabilityCalendarIds
      : [selectedBookingId],
  );
  if (!blockers.includes(selectedBookingId)) blockers.push(selectedBookingId);
  if (blockers.length > 50) {
    throw createError(
      "Google availability checks support up to 50 calendars.",
      400,
      "GOOGLE_TOO_MANY_CALENDARS",
    );
  }

  const invalidBlocker = blockers.find(
    (id) => !byId.get(id)?.canReadAvailability,
  );
  if (invalidBlocker) {
    throw createError(
      "One or more selected availability calendars cannot be read.",
      400,
      "GOOGLE_AVAILABILITY_CALENDAR_UNAVAILABLE",
    );
  }

  const legacySelection =
    bookingCalendarId === undefined &&
    availabilityCalendarIds === undefined;
  if (legacySelection) {
    return IntegrationConnection.findOneAndUpdate(
      { business: businessId, provider: "google_calendar" },
      {
        $set: {
          providerCalendarId: selectedBookingId,
          metadata: { selectedCalendarSummary: bookingCalendar.summary },
          status: "connected",
        },
      },
      { new: true },
    );
  }

  const connection = await IntegrationConnection.findOne({
    business: businessId,
    provider: "google_calendar",
  });
  if (
    !connection ||
    (connection.status && connection.status !== "connected")
  ) {
    throw createError(
      "Google Calendar is not connected.",
      409,
      "GOOGLE_NOT_CONNECTED",
    );
  }

  const previousCalendarId = connection.providerCalendarId;
  connection.providerCalendarId = selectedBookingId;
  connection.providerCalendarName = bookingCalendar.summary;
  connection.availabilityCalendarIds = blockers;
  connection.metadata = {
    ...(connection.metadata || {}),
    selectedCalendarSummary: bookingCalendar.summary,
    googleCalendar: {
      ...(connection.metadata?.googleCalendar || {}),
      bookingCalendarId: selectedBookingId,
      bookingCalendarName: bookingCalendar.summary,
      availabilityCalendarIds: blockers,
      syncEnabled: syncEnabled !== false,
      watchEnabled: watchEnabled !== false,
      sendUpdates: ["all", "externalOnly", "none"].includes(sendUpdates)
        ? sendUpdates
        : "all",
      defaultAttendeeEmail: normalizedOptionalEmail(defaultAttendeeEmail),
      includeEstimatedValue: includeEstimatedValue === true,
      customerRemindersEnabled: customerRemindersEnabled !== false,
      reminderHours: normalizedReminderHours(reminderHours),
      postAppointmentFollowUpEnabled:
        postAppointmentFollowUpEnabled !== false,
      postAppointmentFollowUpDelayHours: Math.max(
        1,
        Math.min(Number(postAppointmentFollowUpDelayHours) || 2, 168),
      ),
      googleChangeApprovalRequired: googleChangeApprovalRequired !== false,
      ...(previousCalendarId && previousCalendarId !== selectedBookingId
        ? { channel: {}, sync: {} }
        : {}),
    },
  };
  if (typeof connection.markModified === "function") {
    connection.markModified("metadata");
  }
  connection.lastVerifiedAt = new Date();
  setConnectionHealthy(connection);
  if (typeof connection.save === "function") {
    await connection.save();
    return connection;
  }

  return IntegrationConnection.findOneAndUpdate(
    { business: businessId, provider: "google_calendar" },
    {
      $set: {
        providerCalendarId: selectedBookingId,
        providerCalendarName: bookingCalendar.summary,
        availabilityCalendarIds: blockers,
        metadata: connection.metadata,
        status: "connected",
        lastVerifiedAt: connection.lastVerifiedAt,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
        lastErrorAt: null,
        lastErrorCode: "",
        lastErrorMessage: "",
      },
    },
    { new: true },
  );
};

export const disconnectGoogleCalendar = async (businessId) => {
  const connection = await getGoogleConnection(businessId, true);

  const channel = connection?.metadata?.googleCalendar?.channel || {};
  if (channel.id && channel.resourceId && connection?.accessTokenEncrypted) {
    try {
      await googleApiRequest({
        businessId,
        path: "/channels/stop",
        method: "POST",
        body: { id: channel.id, resourceId: channel.resourceId },
      });
    } catch {
      // Local disconnection still completes when an old watch already expired.
    }
  }

  const tokenToRevoke = connection?.refreshTokenEncrypted
    ? decryptSecret(connection.refreshTokenEncrypted)
    : connection?.accessTokenEncrypted
      ? decryptSecret(connection.accessTokenEncrypted)
      : "";
  if (tokenToRevoke) {
    try {
      await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokenToRevoke }),
      });
    } catch {
      // Clearing local credentials is mandatory even if revocation fails.
    }
  }

  // Keep the established update contract for existing callers and tests.
  const disconnected = await IntegrationConnection.findOneAndUpdate(
    { business: businessId, provider: "google_calendar" },
    {
      $set: {
        status: "disconnected",
        accessTokenEncrypted: "",
        refreshTokenEncrypted: "",
        tokenExpiresAt: null,
        providerCalendarId: "",
        oauthStateHash: "",
        oauthStateExpiresAt: null,
      },
    },
    { new: true },
  );

  if (!disconnected) return null;

  const googleCalendar = {
    ...(connection?.metadata?.googleCalendar || {}),
    bookingCalendarId: "",
    bookingCalendarName: "",
    availabilityCalendarIds: [],
    channel: {},
    sync: {},
  };
  const additionalFields = {
    providerAccountId: "",
    providerAccountEmail: "",
    providerCalendarName: "",
    availabilityCalendarIds: [],
    watchChannelId: "",
    watchResourceId: "",
    watchExpiresAt: null,
    syncToken: "",
    disconnectedAt: new Date(),
    lastVerifiedAt: null,
    metadata: {
      ...(connection?.metadata || disconnected.metadata || {}),
      googleCalendar,
    },
  };

  if (disconnected._id) {
    await IntegrationConnection.updateOne(
      { _id: disconnected._id, business: businessId },
      { $set: additionalFields },
    );
  }
  Object.assign(disconnected, additionalFields);
  return disconnected;
};

