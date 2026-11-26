import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import Connection from "../../src/models/integrationConnection.js";
import Intent from "../../src/models/integrationDisconnectIntent.js";
import { encryptSecret } from "../../src/services/integrations/tokenEncryption.service.js";
import {
  disconnectGoogleAccount,
  assertGoogleReconnectAllowed,
  processGoogleDisconnectIntent,
  reconcileGoogleDisconnects,
} from "../../src/services/integrations/googleDisconnect.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
let originalFetch;
beforeAll(connectTestDB, 60000);
beforeEach(() => {
  originalFetch = global.fetch;
  process.env.INTEGRATION_ENCRYPTION_KEY =
    "pilot-encryption-key-with-at-least-32-characters";
});
afterEach(async () => {
  global.fetch = originalFetch;
  await clearTestDB();
});
afterAll(closeTestDB);
test("H10 failed revocation remains durable, blocks reconnect, retries and clears encrypted secrets", async () => {
  const { business } = await stabilizationFixture();
  const connection = await Connection.create({
    business: business._id,
    provider: "google_calendar",
    status: "connected",
    accessTokenEncrypted: encryptSecret("synthetic-access"),
    refreshTokenEncrypted: encryptSecret("synthetic-refresh"),
  });
  global.fetch = jest.fn(async () => {
    throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
  });
  const disconnected = await disconnectGoogleAccount(connection);
  expect(disconnected.status).toBe("disconnected");
  expect(disconnected.$locals.revocationPending).toBe(true);
  const local = await Connection.findById(connection._id).select(
    "+accessTokenEncrypted +refreshTokenEncrypted",
  );
  expect(local.accessTokenEncrypted).toBe("");
  expect(local.refreshTokenEncrypted).toBe("");
  await expect(
    assertGoogleReconnectAllowed(business._id),
  ).rejects.toMatchObject({ code: "GOOGLE_DISCONNECT_PENDING" });
  const intent = await Intent.findOne({ business: business._id }).select(
    "+refreshTokenEncrypted",
  );
  expect(intent.refreshTokenEncrypted).toBeTruthy();
  expect(intent.state).toBe("pending");
  await Intent.updateOne(
    { _id: intent._id },
    { $set: { nextAttemptAt: new Date(0) } },
  );
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  expect(
    await processGoogleDisconnectIntent({
      id: intent._id,
      businessId: business._id,
    }),
  ).toBe(true);
  await expect(
    assertGoogleReconnectAllowed(business._id),
  ).resolves.toBeUndefined();
  const completed = await Intent.findById(intent._id).select(
    "+refreshTokenEncrypted",
  );
  expect(completed.state).toBe("completed");
  expect(completed.refreshTokenEncrypted).toBe("");
});
test("H10 an in-flight credential save cannot resurrect a disconnected grant", async () => {
  const { business } = await stabilizationFixture();
  await Connection.create({
    business: business._id,
    provider: "google_calendar",
    status: "connected",
    accessTokenEncrypted: encryptSecret("synthetic-access"),
  });
  const stale = await Connection.findOne({ business: business._id }).select(
    "+accessTokenEncrypted",
  );
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
  await disconnectGoogleAccount(
    await Connection.findOne({ business: business._id }).select(
      "+accessTokenEncrypted",
    ),
  );
  stale.accessTokenEncrypted = encryptSecret("late-token");
  stale.status = "connected";
  await expect(stale.save()).rejects.toBeDefined();
  expect((await Connection.findById(stale._id)).status).toBe("disconnected");
});

test('H10 a normal credential refresh saves in its generation and a later disconnect fences it',async()=>{
 const {business}=await stabilizationFixture();
 await Connection.create({business:business._id,provider:'google_calendar',status:'connected',credentialGeneration:3,accessTokenEncrypted:encryptSecret('synthetic-access')});
 const fresh=await Connection.findOne({business:business._id}).select('+accessTokenEncrypted');fresh.accessTokenEncrypted=encryptSecret('synthetic-refreshed');await fresh.save();
 expect((await Connection.findById(fresh._id)).credentialGeneration).toBe(3);
 await Connection.updateOne({_id:fresh._id},{$set:{credentialGeneration:4,status:'disconnected'}});
 fresh.accessTokenEncrypted=encryptSecret('synthetic-late');await expect(fresh.save()).rejects.toBeDefined();
 expect((await Connection.findById(fresh._id)).status).toBe('disconnected');
});
test('H10 bounded revocation sweep recovers an expired worker lease and a repeated receipt stays inert',async()=>{
 const {business}=await stabilizationFixture();
 const intent=await Intent.create({business:business._id,provider:'google_calendar',fingerprint:'synthetic-revocation',refreshTokenEncrypted:encryptSecret('synthetic-refresh'),state:'processing',leaseUntil:new Date(0),leaseToken:'abandoned'});
 global.fetch=jest.fn(async()=>({ok:true,status:200,json:async()=>({})}));
 await expect(reconcileGoogleDisconnects(1)).resolves.toEqual({processed:1,completed:1});
 expect(global.fetch).toHaveBeenCalledTimes(1);
 await expect(processGoogleDisconnectIntent({id:intent._id,businessId:business._id})).resolves.toBe(false);
 expect(global.fetch).toHaveBeenCalledTimes(1);
 await expect(reconcileGoogleDisconnects()).resolves.toEqual({processed:0,completed:0});
});
