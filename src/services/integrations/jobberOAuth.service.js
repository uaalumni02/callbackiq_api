import crypto from "crypto";

import IntegrationConnection from "../../models/integrationConnection.js";
import { decryptSecret, encryptSecret } from "./tokenEncryption.service.js";

const JOBBER_AUTHORIZATION_URL = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";

const requireJobberConfig = () => {
  const clientId = String(process.env.JOBBER_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.JOBBER_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.JOBBER_REDIRECT_URI || "").trim();
  const stateSecret = String(process.env.OAUTH_STATE_SECRET || "").trim();

  if (!clientId || !clientSecret || !redirectUri || stateSecret.length < 24) {
    const error = new Error(
      "Jobber OAuth is not configured. Set JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REDIRECT_URI, and OAUTH_STATE_SECRET.",
    );
    error.statusCode = 503;
    error.code = "JOBBER_OAUTH_NOT_CONFIGURED";
    throw error;
  }

  return { clientId, clientSecret, redirectUri, stateSecret };
};

const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const signState = (payload, secret) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
};

const verifyState = (state, secret) => {
  const [encoded, signature] = String(state || "").split(".");

  if (!encoded || !signature) {
    throw new Error("Invalid Jobber OAuth state.");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Jobber OAuth state verification failed.");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

  if (!payload.businessId || !payload.exp || Date.now() > Number(payload.exp)) {
    throw new Error("Jobber OAuth state has expired.");
  }

  return payload;
};

const parseJson = async (response, context) => {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.error_description || payload.error || `${context} failed (${response.status}).`,
    );
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerPayload = payload;
    throw error;
  }

  return payload;
};

const exchangeToken = async (parameters) => {
  const { clientId, clientSecret } = requireJobberConfig();
  const response = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...parameters,
    }),
  });

  return parseJson(response, "Jobber token exchange");
};

const getAccountWithToken = async (accessToken) => {
  const apiVersion = String(process.env.JOBBER_API_VERSION || "").trim();

  if (!apiVersion) {
    const error = new Error("JOBBER_API_VERSION must be set to an active Jobber API version.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(JOBBER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": apiVersion,
    },
    body: JSON.stringify({
      query: "query CallBackIQJobberAccount { account { id name } }",
    }),
  });
  const payload = await parseJson(response, "Jobber account lookup");

  if (payload.errors?.length || !payload.data?.account?.id) {
    throw new Error(
      payload.errors?.map((item) => item.message).join("; ") ||
        "Jobber did not return an account.",
    );
  }

  return payload.data.account;
};

export const buildJobberAuthorizationUrl = async (businessId) => {
  const { clientId, redirectUri, stateSecret } = requireJobberConfig();
  const expiresAt = Date.now() + 10 * 60_000;
  const nonce = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = signState(
    { businessId: String(businessId), nonce, exp: expiresAt },
    stateSecret,
  );

  await IntegrationConnection.findOneAndUpdate(
    { business: businessId, provider: "jobber" },
    {
      $set: {
        status: "disconnected",
        oauthStateHash: hashValue(state),
        oauthStateExpiresAt: new Date(expiresAt),
        oauthCodeVerifierEncrypted: encryptSecret(verifier),
      },
      $setOnInsert: { metadata: {} },
    },
    { upsert: true, new: true },
  );

  const url = new URL(JOBBER_AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
};

export const exchangeJobberAuthorizationCode = async ({ code, state }) => {
  const { redirectUri, stateSecret } = requireJobberConfig();
  const payload = verifyState(state, stateSecret);
  const connection = await IntegrationConnection.findOne({
    business: payload.businessId,
    provider: "jobber",
  }).select("+oauthStateHash +oauthStateExpiresAt +oauthCodeVerifierEncrypted");

  if (
    !connection ||
    connection.oauthStateHash !== hashValue(state) ||
    !connection.oauthStateExpiresAt ||
    connection.oauthStateExpiresAt <= new Date() ||
    !connection.oauthCodeVerifierEncrypted
  ) {
    throw new Error("Jobber OAuth state does not match the active connection request.");
  }

  const verifier = decryptSecret(connection.oauthCodeVerifierEncrypted);
  const tokens = await exchangeToken({
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Jobber did not return the required access and refresh tokens.");
  }

  const account = await getAccountWithToken(tokens.access_token);
  const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);

  connection.status = "connected";
  connection.accessTokenEncrypted = encryptSecret(tokens.access_token);
  connection.refreshTokenEncrypted = encryptSecret(tokens.refresh_token);
  connection.tokenExpiresAt = expiresAt;
  connection.providerAccountId = String(account.id);
  connection.apiVersion = String(process.env.JOBBER_API_VERSION || "").trim();
  connection.metadata = {
    ...(connection.metadata || {}),
    accountName: account.name || "",
    tokenType: tokens.token_type || "Bearer",
  };
  connection.oauthStateHash = "";
  connection.oauthStateExpiresAt = null;
  connection.oauthCodeVerifierEncrypted = "";
  connection.lastSuccessfulSyncAt = new Date();
  connection.lastErrorAt = null;
  connection.lastErrorMessage = "";
  await connection.save();

  return { businessId: payload.businessId, connection, account };
};

export const refreshJobberAccessToken = async (connection) => {
  const selectedConnection = connection?.refreshTokenEncrypted
    ? connection
    : await IntegrationConnection.findById(connection?._id).select(
        "+accessTokenEncrypted +refreshTokenEncrypted",
      );

  if (!selectedConnection?.refreshTokenEncrypted) {
    const error = new Error("Jobber refresh token is unavailable.");
    error.statusCode = 409;
    error.code = "JOBBER_REAUTHORIZATION_REQUIRED";
    throw error;
  }

  try {
    const tokens = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: decryptSecret(selectedConnection.refreshTokenEncrypted),
    });

    selectedConnection.accessTokenEncrypted = encryptSecret(tokens.access_token);
    if (tokens.refresh_token) {
      selectedConnection.refreshTokenEncrypted = encryptSecret(tokens.refresh_token);
    }
    selectedConnection.tokenExpiresAt = new Date(
      Date.now() + Number(tokens.expires_in || 3600) * 1000,
    );
    selectedConnection.status = "connected";
    selectedConnection.lastErrorAt = null;
    selectedConnection.lastErrorMessage = "";
    await selectedConnection.save();
    return selectedConnection;
  } catch (error) {
    selectedConnection.status = "expired";
    selectedConnection.lastErrorAt = new Date();
    selectedConnection.lastErrorMessage = error.message;
    await selectedConnection.save();
    throw error;
  }
};

export const disconnectJobber = async (businessId) => {
  const connection = await IntegrationConnection.findOne({
    business: businessId,
    provider: "jobber",
  }).select("+accessTokenEncrypted +refreshTokenEncrypted");

  if (!connection) {
    return null;
  }

  if (connection.status === "connected" && connection.accessTokenEncrypted) {
    try {
      const response = await fetch(JOBBER_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${decryptSecret(connection.accessTokenEncrypted)}`,
          "Content-Type": "application/json",
          "X-JOBBER-GRAPHQL-VERSION":
            connection.apiVersion || process.env.JOBBER_API_VERSION,
        },
        body: JSON.stringify({
          query:
            "mutation CallBackIQJobberDisconnect { appDisconnect { app { name } userErrors { message } } }",
        }),
      });
      await response.json().catch(() => ({}));
    } catch {
      /* Local revocation still completes so CallBackIQ cannot reuse stale tokens. */
    }
  }

  connection.status = "disconnected";
  connection.accessTokenEncrypted = "";
  connection.refreshTokenEncrypted = "";
  connection.tokenExpiresAt = null;
  connection.oauthStateHash = "";
  connection.oauthStateExpiresAt = null;
  connection.oauthCodeVerifierEncrypted = "";
  await connection.save();
  return connection;
};
