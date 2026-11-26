import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import Operations from "../../src/models/businessOperationsSettings.js";
import {
  resolveStaffRecipients,
  dispatchStaffRecipients,
} from "../../src/services/notifications/recipientPolicy.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
async function fixture() {
  const { business } = await stabilizationFixture();
  await Operations.create({
    business: business._id,
    humanHandoffContacts: [
      {
        name: "Dispatcher",
        email: "dispatcher@example.test",
        phone: "+15555550121",
        active: true,
      },
      { name: "Off duty", email: "off@example.test", active: false },
      {
        name: "Urgent only",
        email: "urgent-only@example.test",
        active: true,
        emergencyOnly: true,
      },
    ],
    emergencyPolicy: {
      emergencyContactPhone: "+15555550122",
      emergencyContactEmail: "urgent@example.test",
    },
  });
  return business;
}
test("H02 saved active team contacts govern ordinary email and SMS recipients", async () => {
  const b = await fixture();
  expect(
    (await resolveStaffRecipients({ businessId: b._id, channel: "email" })).map(
      (r) => r.address,
    ),
  ).toEqual(["dispatcher@example.test"]);
  expect(
    (await resolveStaffRecipients({ businessId: b._id, channel: "sms" })).map(
      (r) => r.address,
    ),
  ).toEqual(["+15555550121"]);
});
test("H11 every critical alert includes the saved urgent phone and email", async () => {
  const b = await fixture();
  expect(
    (
      await resolveStaffRecipients({
        businessId: b._id,
        channel: "email",
        critical: true,
      })
    ).map((r) => r.address),
  ).toEqual(
    expect.arrayContaining(["urgent@example.test", "urgent-only@example.test"]),
  );
  expect(
    (
      await resolveStaffRecipients({
        businessId: b._id,
        channel: "sms",
        critical: true,
      })
    ).map((r) => r.address),
  ).toContain("+15555550122");
});
test("H02 accepted recipients are not resent after partial success or repeated delivery", async () => {
  const b = await fixture();
  const send = jest.fn(async () => ({
    accepted: ["synthetic"],
    messageId: "synthetic",
  }));
  const options = {
    businessId: b._id,
    channel: "email",
    key: "alert-synthetic:initial",
    send,
    payload: (recipient) => ({ email: recipient.address }),
  };
  expect((await dispatchStaffRecipients(options)).state).toBe("accepted");
  expect((await dispatchStaffRecipients(options)).state).toBe("accepted");
  expect(send).toHaveBeenCalledTimes(1);
});
test("H02 changed recipients are rechecked before dispatch and uncertainty is not automatically retried", async () => {
  const b = await fixture();
  const send = jest.fn(async () => {
    throw new Error("unknown sender outcome");
  });
  const options = {
    businessId: b._id,
    channel: "sms",
    key: "alert-synthetic:initial",
    send,
    payload: (recipient) => ({ to: recipient.address }),
  };
  expect((await dispatchStaffRecipients(options)).state).toBe("uncertain");
  await dispatchStaffRecipients(options);
  expect(send).toHaveBeenCalledTimes(1);
});
test("H11 the real SMS poll sends to the urgent contact even with no legacy SMS policy", async () => {
  const b = await fixture();
  const { default: Alert } = await import("../../src/models/alert.js");
  const { runStaffSms } =
    await import("../../src/services/staffSms.service.js");
  const alert = await Alert.create({
    business: b._id,
    type: "human_requested",
    priority: "critical",
    title: "Synthetic safety concern",
    message: "Synthetic test",
    actionRequired: true,
  });
  const send = jest.fn(async () => ({ sid: "SM-synthetic" }));
  await runStaffSms({ send, limit: 2 });
  expect(send.mock.calls.map(([payload]) => payload.to)).toContain(
    "+15555550122",
  );
  expect(
    send.mock.calls.every(([payload]) => payload.bypassQuietHours === true),
  ).toBe(true);
  await runStaffSms({ send, limit: 2 });
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    (await Alert.findById(alert._id)).metadata.staffSms.initial.state,
  ).toBe("sent");
});
test("M05 keyset pages remain bounded and rotate past tenants with no saved recipient", async () => {
  const b = await fixture();
  const { default: Alert } = await import("../../src/models/alert.js");
  const { runStaffSms } =
    await import("../../src/services/staffSms.service.js");
  await Alert.create(
    [1, 2, 3].map((n) => ({
      business: b._id,
      type: "human_requested",
      priority: "high",
      title: `Synthetic ${n}`,
      message: "Synthetic test",
      actionRequired: true,
    })),
  );
  const send = jest.fn(async () => ({ sid: "SM-synthetic" }));
  expect((await runStaffSms({ send, limit: 2 })).scanned).toBe(2);
  expect((await runStaffSms({ send, limit: 2 })).scanned).toBe(1);
  expect(send).toHaveBeenCalledTimes(3);
});

test('H11 acknowledging a critical alert cannot suppress the saved urgent SMS and email',async()=>{
 const b=await fixture();const {default:Alert}=await import('../../src/models/alert.js');const {runStaffSms}=await import('../../src/services/staffSms.service.js');const {runStaffNotificationsOnce}=await import('../../src/services/staffNotification.service.js');
 await Alert.create({business:b._id,type:'human_requested',priority:'critical',title:'Synthetic critical alert',message:'Synthetic safety concern',actionRequired:false,acknowledgedAt:new Date(),resolvedAt:new Date()});
 const sms=jest.fn(async()=>({sid:'SM-synthetic'})),email=jest.fn(async()=>({accepted:['synthetic'],messageId:'synthetic'}));process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';
 try{await runStaffSms({send:sms});await runStaffNotificationsOnce({send:email});expect(sms.mock.calls.map(([p])=>p.to)).toContain('+15555550122');expect(email.mock.calls.map(([p])=>p.email)).toContain('urgent@example.test');}finally{delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;}
});
