import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import VoiceSession from "../../src/models/voiceSession.js";
import VoiceCallback from "../../src/voice/voiceCallback.service.js";
import Lead from "../../src/models/lead.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
test("B05 non-stop service description remains a submitted callback after explicit confirmation", async () => {
  const { business, lead, conversation } = await stabilizationFixture();
  const row = await VoiceSession.create({
    business: business._id,
    lead: lead._id,
    conversation: conversation._id,
    from: lead.phone,
    to: "+14045550101",
    providerCallSid: "CA_WITHDRAWAL",
    status: "active",
  });
  const session = await row.populate(["business", "lead", "conversation"]);
  const first = await VoiceCallback.handle({
    session,
    customerMessage: "I need a non-stop dripping faucet repaired",
    seed: {
      serviceNeeded: "Non-stop dripping faucet repair",
      customerName: "Alex Smith",
      location: "123 Test St, Atlanta, GA 30301",
      urgency: "medium",
      urgencyDetail: "Routine repair",
      preferredTime: "Tomorrow afternoon",
      phone: lead.phone,
    },
    sendConfirmationSms: false,
  });
  expect(first.callbackCanceled).not.toBe(true);
  const result = await VoiceCallback.handle({
    session,
    customerMessage: "yes",
    sendConfirmationSms: false,
  });
  expect(result.callbackCaptured).toBe(true);
  expect((await VoiceSession.findById(row._id)).status).not.toBe("canceled");
  expect((await Lead.findById(lead._id)).serviceNeeded).toMatch(/non-stop/i);
});
