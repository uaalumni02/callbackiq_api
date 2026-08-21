// CALLBACKIQ_PRODUCTION_HARDENING_V1_1
import mongoose from "mongoose";

const TRANSACTION_CAPABLE_TOPOLOGIES = new Set([
  "ReplicaSetWithPrimary",
  "ReplicaSetNoPrimary",
  "Sharded",
  "LoadBalanced",
]);

export const registrationTransactionsRequired = (env = process.env) =>
  ["production", "staging"].includes(
    String(env.NODE_ENV || "").trim().toLowerCase(),
  ) ||
  String(env.REGISTRATION_TRANSACTION_REQUIRED || "")
    .trim()
    .toLowerCase() === "true";

export const mongoDeploymentSupportsTransactions = (
  connection = mongoose.connection,
) => {
  const topologyType = String(
    connection?.client?.topology?.description?.type || "",
  ).trim();

  return TRANSACTION_CAPABLE_TOPOLOGIES.has(topologyType);
};

export const runRegistrationTransaction = async (
  operation,
  {
    connection = mongoose.connection,
    startSession = () => mongoose.startSession(),
    env = process.env,
  } = {},
) => {
  if (typeof operation !== "function") {
    throw new TypeError("Registration transaction operation must be a function");
  }

  if (!mongoDeploymentSupportsTransactions(connection)) {
    if (registrationTransactionsRequired(env)) {
      throw new Error(
        "Registration requires a transaction-capable MongoDB deployment in production/staging. Use MongoDB Atlas, a replica set, or mongos.",
      );
    }

    // Local/test standalone MongoDB remains supported. Passing a null session
    // causes the persistence helpers to use their ordinary non-transactional
    // save path without generating transaction numbers/retryable-write errors.
    return operation(null);
  }

  const session = await startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

export default runRegistrationTransaction;
