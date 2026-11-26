import mongoose from "mongoose";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import {
  reserveVoiceUsage,
  reconcileVoiceUsage,
  releaseVoiceUsageReservation,
} from "../../src/services/voiceUsage.service.js";
import Counter from "../../src/models/providerBudgetCounter.js";
import Reservation from "../../src/models/voiceUsageReservation.js";
import Ledger from "../../src/models/voiceUsageLedger.js";
import VoiceMaintenance from "../../src/voice/voiceSessionMaintenance.service.js";
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
test("B03 real voice ledger and provider budget settle multiple reservations once from verified elapsed time", async () => {
  const { business } = await stabilizationFixture();
  const sessionId = new mongoose.Types.ObjectId();
  for (const key of ["first", "extension"])
    await expect(
      reserveVoiceUsage({
        business,
        sessionId,
        reservationKey: "synthetic-" + key,
        reserveSeconds: 60,
      }),
    ).resolves.toMatchObject({ allowed: true });
  expect((await Counter.find().lean()).map((r) => r.used)).toEqual([
    120, 120, 120, 120,
  ]);
  const receipt = { businessId: business._id, sessionId, actualSeconds: 75 };
  await expect(reconcileVoiceUsage(receipt)).resolves.toMatchObject({
    reconciled: true,
  });
  expect((await Counter.find().lean()).map((r) => r.used)).toEqual([
    75, 75, 75, 75,
  ]);
  await expect(reconcileVoiceUsage(receipt)).resolves.toMatchObject({
    replayed: true,
    reconciled: true,
  });
  expect((await Counter.find().lean()).map((r) => r.used)).toEqual([
    75, 75, 75, 75,
  ]);
  expect(
    (await Ledger.find({ business: business._id })).map(
      (r) => r.completedSeconds,
    ),
  ).toEqual([75, 75]);
});
test("B03 an abandoned voice reservation is released once after its lease without refunding another session", async () => {
  const { business } = await stabilizationFixture();
  const expired = await reserveVoiceUsage({
    business,
    sessionId: new mongoose.Types.ObjectId(),
    reservationKey: "synthetic-expired",
    reserveSeconds: 60,
  });
  await reserveVoiceUsage({
    business,
    sessionId: new mongoose.Types.ObjectId(),
    reservationKey: "synthetic-other",
    reserveSeconds: 60,
  });
  await Reservation.updateOne(
    { _id: expired.reservationId },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await expect(
    releaseVoiceUsageReservation({ reservationId: expired.reservationId }),
  ).resolves.toMatchObject({ state: "released" });
  expect((await Counter.find().lean()).map((r) => r.used)).toEqual([
    60, 60, 60, 60,
  ]);
  await releaseVoiceUsageReservation({ reservationId: expired.reservationId });
  expect((await Counter.find().lean()).map((r) => r.used)).toEqual([
    60, 60, 60, 60,
  ]);
});
test("M06 default retention and stale-session settings execute safely on an empty tenant set", async () => {
  await expect(
    VoiceMaintenance.redactExpiredTranscripts(),
  ).resolves.toMatchObject({ retentionDays: 30, modified: 0 });
  await expect(VoiceMaintenance.reapStaleSessions()).resolves.toMatchObject({
    scanned: 0,
    errors: 0,
  });
});
test("M06 an explicit operational retention request applies its own cutoff rather than silently changing it", async () => {
  await expect(
    VoiceMaintenance.redactExpiredTranscripts({ retentionDays: 10 }),
  ).resolves.toMatchObject({ retentionDays: 10, modified: 0 });
});
test("H02 the default approval polling entry point safely drains an empty partition", async () => {
  const { runApprovalSms } =
    await import("../../src/services/scheduling/approvalSms.service.js");
  const previous = process.env.STAFF_APPROVAL_SMS_ENABLED;
  process.env.STAFF_APPROVAL_SMS_ENABLED = "true";
  try {
    await expect(runApprovalSms()).resolves.toMatchObject({ sent: 0 });
  } finally {
    if (previous === undefined) delete process.env.STAFF_APPROVAL_SMS_ENABLED;
    else process.env.STAFF_APPROVAL_SMS_ENABLED = previous;
  }
});
