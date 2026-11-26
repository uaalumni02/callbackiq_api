import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import VoiceSession from "../../src/models/voiceSession.js";
import Alert from "../../src/models/alert.js";
import User from "../../src/models/user.js";
import { BUSINESS_TYPES } from "../../src/helpers/businessTypes.js";
import { pilotSafetyCases } from "../fixtures/pilotSafetyMatrix.js";
import { signedTwilioPost } from "../helpers/signTwilioRequest.js";
import { getTwilioClient } from "../../src/services/twilioSmsService.js";
import { runVoiceConversationTurn } from "../../src/services/voiceConversationTurn.service.js";
import VoiceAgent from "../../src/voice/voiceAgent.service.js";
import { drainWebhookWorkOnce } from "../../src/workers/webhookWork.worker.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
let sequence = 0,
  apiKey;
beforeAll(async () => {
  apiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";
  await connectTestDB();
}, 60000);
afterEach(clearTestDB);
afterAll(async () => {
  process.env.OPENAI_API_KEY = apiKey;
  await closeTestDB();
});
const phone = () => `+1404555${String(++sequence).padStart(4, "0")}`;
test.each(BUSINESS_TYPES)(
  "B01 %s entire hazard matrix survives SMS and voice with the model down",
  async (trade) => {
    const owner = await User.create({
      userName: "safety-owner",
      email: "safety@example.test",
      password: "inert-hash",
      businessName: "Safety fixture",
      role: "owner",
      emailVerifiedAt: new Date(),
    });
    const business = await Business.create({
      owner: owner._id,
      businessName: "Safety fixture",
      businessType: trade,
      forwardingPhone: phone(),
      phone: phone(),
      trackingNumber: { status: "active", providerSid: "PN_SAFE" },
      messagingCompliance: {
        smsReady: true,
        senderAttached: true,
        a2pStatus: "registered",
      },
      features: { aiQualificationEnabled: true },
    });
    await Subscription.create({
      business: business._id,
      status: "active",
      isActive: true,
    });
    let sms = 0;
    const send = jest
      .spyOn(getTwilioClient().messages, "create")
      .mockImplementation(async () => ({
        sid: "SM_SAFE_" + ++sms,
        status: "queued",
      }));
    for (const [text, hazard] of pilotSafetyCases) {
      const caller = phone();
      const response = await signedTwilioPost(app, "/api/twilio/sms", {
        MessageSid: "SM_IN_" + sequence,
        From: caller,
        To: business.phone,
        Body: text,
      });
      expect(response.status).toBe(200);
      const smsAlert = await Alert.findOne({
        business: business._id,
        "metadata.customerPhone": caller,
        type: "safety_emergency",
        priority: "critical",
      });
      expect(smsAlert).toBeTruthy();
      const lead = await Lead.create({
        business: business._id,
        phone: phone(),
        serviceNeeded: "Unknown",
      });
      const conversation = await Conversation.create({
        business: business._id,
        lead: lead._id,
        customerPhone: lead.phone,
      });
      const session = await VoiceSession.create({
        business: business._id,
        lead: lead._id,
        conversation: conversation._id,
        from: lead.phone,
        to: business.phone,
        providerCallSid: "CA_SAFE_" + sequence,
        status: "active",
      });
      await session.populate(["business", "lead", "conversation"]);
      const result = await runVoiceConversationTurn({
        session,
        customerMessage: text,
        turnId: String(sequence),
        operation: () =>
          VoiceAgent.handlePrompt({ session, customerMessage: text }),
      });
      expect(result.reply).toMatch(/911|nine one one/);
      expect(result.outcome).toBe("safety_guidance");
      await drainWebhookWorkOnce();
      expect(
        await Alert.exists({
          business: business._id,
          conversation: conversation._id,
          type: "safety_emergency",
          priority: "critical",
          "metadata.hazardType": hazard,
        }),
      ).toBeTruthy();
    }
    expect(send).toHaveBeenCalled();
  },
  120000,
);
