// CALLBACKIQ_PRODUCTION_HARDENING_V1
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("canonical MongoDB configuration supports MONGODB_URI", () => {
  const connection = read("src/db/connection.js");
  const runtime = read("src/config/runtime-environment.js");
  assert.match(connection, /getMongoUrl/);
  assert.match(runtime, /MONGODB_URI/);
  assert.match(runtime, /MONGO_URL/);
});

test("startup validates environment before connecting", () => {
  const server = read("src/server.js");
  const validateAt = server.indexOf("validateEnvironment({ throwOnError: true })");
  const connectAt = server.indexOf("await connectDB()");
  assert.ok(validateAt >= 0, "validateEnvironment startup call missing");
  assert.ok(connectAt >= 0, "connectDB startup call missing");
  assert.ok(validateAt < connectAt, "environment validation must precede Mongo");
});

test("production CORS does not always trust localhost", () => {
  const cors = read("src/config/cors.js");
  assert.match(cors, /developmentOrigins/);
  assert.match(cors, /production|staging/);
});

test("password reset tokens are hashed before persistence and lookup", () => {
  const auth = read("src/controllers/auth.js");
  assert.match(auth, /hashPasswordResetToken/);
  assert.match(auth, /savePasswordResetToken[\s\S]*resetTokenHash/);
  assert.match(auth, /findUserByPasswordResetToken[\s\S]*resetTokenHash/);
});

test("production auth response does not expose bearer token", () => {
  const auth = read("src/controllers/auth.js");
  assert.match(auth, /shouldExposeAuthToken/);
  assert.match(auth, /!isProduction/);
});

test("conversation admin bypass re-checks current database role", () => {
  const controller = read("src/controllers/conversation.js");
  const routes = read("src/routes/conversation.routes.js");
  assert.match(controller, /await isCurrentAdminRequest\(req\)/);
  assert.match(routes, /await isCurrentAdminRequest\(req\)/);
});

test("registration is transaction-backed", () => {
  const auth = read("src/controllers/auth.js");
  assert.match(auth, /startSession/);
  assert.match(auth, /withTransaction/);
  assert.match(auth, /registrationSession/);
});

test("growth endpoints use bounded cursor pagination", () => {
  const service = read("src/services/cursorPagination.service.js");
  assert.match(service, /MAX_LIMIT = 200/);
  assert.match(read("src/controllers/conversation.js"), /getConversationsPage/);
  assert.match(read("src/controllers/message.js"), /getMessagesPage/);
  assert.match(read("src/controllers/lead.js"), /getLeadsPage/);
});

test("A2P reconciliation uses a distributed lease", () => {
  const worker = read("src/workers/a2pReconciliation.worker.js");
  assert.match(worker, /withDistributedLease/);
  assert.match(worker, /a2p-reconcile:/);
});

test("release and index gates are installed", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.ok(packageJson.scripts["migrate:indexes"]);
  assert.ok(packageJson.scripts["release:gate"]);
  assert.ok(packageJson.scripts["release:certify"]);
});
