import crypto from "crypto";

import IntegrationConnection from "../../models/integrationConnection.js";
import { decryptSecret, encryptSecret } from "./tokenEncryption.service.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

const requireGoogleConfig = () => {
  const clientId = String(process.env.GOOGLE_CALENDAR_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_CALENDAR_REDIRECT_URI || "").trim();
  const stateSecret = String(process.env.OAUTH_STATE_SECRET || "").trim();

  if (!clientId || !clientSecret || !redirectUri || stateSecret.length < 24) {
    const error = new Error(
      "Google Calendar OAuth is not configured. Set GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REDIRECT_URI, and OAUTH_STATE_SECRET.",
    );
    error.statusCode = 503;
    error.code = "GOOGLE_OAUTH_NOT_CONFIGURED";
    throw error;
  }

  return { clientId, clientSecret, redirectUri, stateSecret };
};

const hashState = (state) =>
  crypto.createHash("sha256").update(String(state)).digest("hex");

const signState = (payload, secret) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
};

const parseSignedState = (state, secret) => {
  const [encoded, signature] = String(state || "").split(".");

  if (!encoded || !signature) {
    throw new Error("Invalid OAuth state.");
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
    throw new Error("OAuth state signature verification failed.");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

  if (!payload.businessId || !payload.exp || Date.now() > Number(payload.exp)) {
    throw new Error("OAuth state has expired.");
  }

  return payload;
};

const parseJsonResponse = async (response, context) => {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.error ||
      `${context} failed with status ${response.status}`;
    const error = new Error(String(message));
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerPayload = payload;
    throw error;
  }

  return payload;
};

export const buildGoogleAuthorizationUrl = async (businessId) => {
  const { clientId, redirectUri, stateSecret } = requireGoogleConfig();
  const nonce = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + 10 * 60_000;
  const state = signState(
    { businessId: String(businessId), nonce, exp: expiresAt },
    stateSecret,
  );

  await IntegrationConnection.findOneAndUpdate(
    { business: businessId, provider: "google_calendar" },
    {
      $set: {
        oauthStateHash: hashState(state),
        oauthStateExpiresAt: new Date(expiresAt),
        status: "disconnected",
      },
      $setOnInsert: { metadata: {} },
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
  url.searchParams.set("scope", DEFAULT_SCOPES.join(" "));
  url.searchParams.set("state", state);

  return url.toString();
};

export const exchangeGoogleAuthorizationCode = async ({ code, state }) => {
  const { clientId, clientSecret, redirectUri, stateSecret } = requireGoogleConfig();
  const payload = parseSignedState(state, stateSecret);
  const connection = await IntegrationConnection.findOne({
    business: payload.businessId,
    provider: "google_calendar",
  }).select("+oauthStateHash +oauthStateExpiresAt +refreshTokenEncrypted");

  if (
    !connection ||
    connection.oauthStateHash !== hashState(state) ||
    !connection.oauthStateExpiresAt ||
    connection.oauthStateExpiresAt < new Date()
  ) {
    const error = new Error("OAuth state does not match the pending connection.");
    error.statusCode = 400;
    throw error;
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokens = await parseJsonResponse(response, "Google token exchange");

  connection.accessTokenEncrypted = encryptSecret(tokens.access_token);
  if (tokens.refresh_token) {
    connection.refreshTokenEncrypted = encryptSecret(tokens.refresh_token);
  }
  connection.tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
    : null;
  connection.scopes = String(tokens.scope || DEFAULT_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  connection.status = "connected";
  connection.oauthStateHash = "";
  connection.oauthStateExpiresAt = null;
  connection.lastSuccessfulSyncAt = new Date();
  connection.lastErrorAt = null;
  connection.lastErrorMessage = "";
  await connection.save();

  return { businessId: payload.businessId, connection };
};

export const getGoogleConnection = async (businessId, includeSecrets = false) => {
  let query = IntegrationConnection.findOne({
    business: businessId,
    provider: "google_calendar",
  });

  if (includeSecrets) {
    query = query.select("+accessTokenEncrypted +refreshTokenEncrypted");
  }

  return query;
};

export const getGoogleAccessToken = async (businessId) => {
  const { clientId, clientSecret } = requireGoogleConfig();
  const connection = await getGoogleConnection(businessId, true);

  if (!connection || !["connected", "expired"].includes(connection.status)) {
    const error = new Error("Google Calendar is not connected.");
    error.statusCode = 409;
    error.code = "GOOGLE_NOT_CONNECTED";
    throw error;
  }

  const hasUsableAccessToken =
    connection.accessTokenEncrypted &&
    (!connection.tokenExpiresAt || connection.tokenExpiresAt > new Date(Date.now() + 60_000));

  if (hasUsableAccessToken) {
    return { token: decryptSecret(connection.accessTokenEncrypted), connection };
  }

  if (!connection.refreshTokenEncrypted) {
    connection.status = "expired";
    connection.lastErrorAt = new Date();
    connection.lastErrorMessage = "Google refresh token is unavailable.";
    await connection.save();
    const error = new Error("Google Calendar authorization has expired.");
    error.statusCode = 409;
    error.code = "GOOGLE_AUTH_EXPIRED";
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
    const tokens = await parseJsonResponse(response, "Google token refresh");
    connection.accessTokenEncrypted = encryptSecret(tokens.access_token);
    connection.tokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
      : null;
    connection.status = "connected";
    connection.lastSuccessfulSyncAt = new Date();
    connection.lastErrorAt = null;
    connection.lastErrorMessage = "";
    await connection.save();

    return { token: tokens.access_token, connection };
  } catch (error) {
    connection.status = "error";
    connection.lastErrorAt = new Date();
    connection.lastErrorMessage = error.message;
    await connection.save();
    throw error;
  }
};

export const googleApiRequest = async ({ businessId, path, method = "GET", body }) => {
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
    const payload = await parseJsonResponse(response, `Google Calendar ${method} ${path}`);
    await IntegrationConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          status: "connected",
          lastSuccessfulSyncAt: new Date(),
          lastErrorAt: null,
          lastErrorMessage: "",
        },
      },
    );
    return payload;
  } catch (error) {
    await IntegrationConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          status: response.status === 401 ? "expired" : "error",
          lastErrorAt: new Date(),
          lastErrorMessage: error.message,
        },
      },
    );
    throw error;
  }
};

export const listGoogleCalendars = async (businessId) => {
  const payload = await googleApiRequest({
    businessId,
    path: "/users/me/calendarList?minAccessRole=writer&showHidden=false",
  });

  return (payload.items || []).map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary,
    primary: Boolean(calendar.primary),
    selected: Boolean(calendar.selected),
    accessRole: calendar.accessRole,
    timeZone: calendar.timeZone,
  }));
};

export const selectGoogleCalendar = async ({ businessId, calendarId }) => {
  const normalizedCalendarId = String(calendarId || "").trim();

  if (!normalizedCalendarId) {
    const error = new Error("calendarId is required.");
    error.statusCode = 400;
    throw error;
  }

  const calendars = await listGoogleCalendars(businessId);
  const selected = calendars.find((calendar) => calendar.id === normalizedCalendarId);

  if (!selected) {
    const error = new Error("The selected Google Calendar was not found or is not writable.");
    error.statusCode = 404;
    throw error;
  }

  return IntegrationConnection.findOneAndUpdate(
    { business: businessId, provider: "google_calendar" },
    {
      $set: {
        providerCalendarId: normalizedCalendarId,
        metadata: { selectedCalendarSummary: selected.summary },
        status: "connected",
        lastSuccessfulSyncAt: new Date(),
      },
    },
    { new: true },
  );
};

export const disconnectGoogleCalendar = async (businessId) => {
  return IntegrationConnection.findOneAndUpdate(
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
};
