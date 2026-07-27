import IntegrationConnection from "../../models/integrationConnection.js";
import { decryptSecret } from "./tokenEncryption.service.js";
import { refreshJobberAccessToken } from "./jobberOAuth.service.js";

const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const REFRESH_SKEW_MS = 2 * 60_000;

export const getJobberConnection = async (businessId, includeSecrets = false) => {
  let query = IntegrationConnection.findOne({
    business: businessId,
    provider: "jobber",
  });

  if (includeSecrets) {
    query = query.select("+accessTokenEncrypted +refreshTokenEncrypted");
  }

  return query;
};

const getUsableConnection = async (businessId) => {
  let connection = await getJobberConnection(businessId, true);

  if (!connection || connection.status !== "connected") {
    const error = new Error("Jobber is not connected.");
    error.statusCode = 409;
    error.code = "JOBBER_NOT_CONNECTED";
    throw error;
  }

  if (
    !connection.accessTokenEncrypted ||
    !connection.tokenExpiresAt ||
    connection.tokenExpiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS
  ) {
    connection = await refreshJobberAccessToken(connection);
  }

  return connection;
};

const executeRequest = async ({ connection, query, variables }) => {
  const apiVersion = connection.apiVersion || process.env.JOBBER_API_VERSION;

  if (!apiVersion) {
    const error = new Error("JOBBER_API_VERSION must be configured.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(JOBBER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${decryptSecret(connection.accessTokenEncrypted)}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": apiVersion,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));

  return { response, payload };
};

export const jobberGraphqlRequest = async ({ businessId, query, variables = {} }) => {
  let connection = await getUsableConnection(businessId);
  let { response, payload } = await executeRequest({ connection, query, variables });

  /* A token may be revoked between the proactive expiry check and this call. */
  if (response.status === 401 && connection.refreshTokenEncrypted) {
    connection = await refreshJobberAccessToken(connection);
    ({ response, payload } = await executeRequest({ connection, query, variables }));
  }

  if (!response.ok || payload.errors?.length) {
    const error = new Error(
      payload.errors?.map((item) => item.message).join("; ") ||
        `Jobber request failed with status ${response.status}`,
    );
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.providerPayload = payload;
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

  return payload.data;
};

export const assertNoJobberUserErrors = (result, operationName) => {
  const userErrors = result?.userErrors || [];

  if (userErrors.length > 0) {
    const error = new Error(
      userErrors
        .map((item) => item.message || item.errorType || "Jobber mutation failed")
        .join("; "),
    );
    error.code = "JOBBER_USER_ERROR";
    error.statusCode = 409;
    error.operationName = operationName;
    error.userErrors = userErrors;
    throw error;
  }
};
