import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
import {
  stabilizationFixture,
  deferred,
} from "../setup/stabilizationFixture.js";
import Sessions from "../../src/models/voiceSession.js";
import Heartbeat from "../../src/models/maintenanceTaskHeartbeat.js";
import { runPilotMaintenanceOnce } from "../../src/services/privacy/pilotMaintenance.service.js";
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
test("M06 a leased scheduled sweep redacts expired transcripts, reaps stale sessions and records success", async () => {
  const { business } = await stabilizationFixture();
  const old = new Date(Date.now() - 40 * 86400000);
  const fields = {
    business: business._id,
    from: "+15555550123",
    to: "+15555550124",
  };
  const redacted = await Sessions.create({
    ...fields,
    providerCallSid: "CA-redact-synthetic",
    status: "completed",
    endedAt: old,
    transcript: [{ role: "customer", text: "Synthetic private transcript" }],
    summary: "Synthetic private summary",
  });
  const stale = await Sessions.create({
    ...fields,
    providerCallSid: "CA-stale-synthetic",
    status: "active",
    lastActivityAt: old,
    fallbackSmsStatus: "suppressed",
  });
  await runPilotMaintenanceOnce();
  expect((await Sessions.findById(redacted._id)).transcript).toHaveLength(0);
  expect((await Sessions.findById(stale._id)).status).toBe("failed");
  expect(
    (await Heartbeat.findById("pilot-privacy")).lastSucceededAt,
  ).toBeInstanceOf(Date);
});
test("M06 simultaneous worker instances cannot run the same maintenance task", async () => {
  const gate = deferred(),
    entered = deferred();
  let calls = 0;
  const operations = {
    redact: async () => {
      calls++;
      entered.resolve();
      await gate.promise;
      return { modified: 0 };
    },
    reap: async () => ({ errors: 0 }),
    deletions: async () => ({ processed: 0 }),
  };
  const first = runPilotMaintenanceOnce({ operations });
  await entered.promise;
  const second = await runPilotMaintenanceOnce({ operations });
  expect(second.skipped).toBe(true);
  gate.resolve();
  await first;
  expect(calls).toBe(1);
});
