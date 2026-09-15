import mongoose from "mongoose";

import Business from "../../../../src/models/business.js";
import VoiceSession from "../../../../src/models/voiceSession.js";
import VoiceSessionService from "../../../../src/voice/voiceSession.service.js";
import VoiceTranscriptService from "../../../../src/voice/voiceTranscript.service.js";
import {
  acquireVoiceCapacity,
  releaseVoiceCapacity,
} from "../../../../src/services/voiceCapacity.service.js";

import {
  BUSINESS_NUMBER,
  TRANSFER_NUMBER,
} from "./syntheticCallFactory.js";

export const createConcurrencyBusiness = async ({ maxConcurrentCalls = 25, phone = BUSINESS_NUMBER } = {}) =>
  Business.create({
    owner: new mongoose.Types.ObjectId(),
    businessName: `Concurrency Plumbing ${Date.now()}-${Math.random().toString(16).slice(2)}`,
    businessType: "plumbing",
    phone,
    forwardingPhone: TRANSFER_NUMBER,
    isActive: true,
    features: {
      voiceAiEnabled: true,
      missedCallSmsEnabled: false,
      aiBookingEnabled: false,
    },
    voiceSettings: {
      answerMode: "always",
      maxConcurrentCalls,
      maxCallDurationSeconds: 600,
      liveTransferEnabled: true,
      transferPhone: TRANSFER_NUMBER,
      liveTransferPhone: TRANSFER_NUMBER,
      agentConfirmationRequired: true,
    },
  });

export const establishCalls = async ({ business, calls, activate = true }) => {
  const contexts = await Promise.all(
    calls.map((call) =>
      VoiceSessionService.ensureContext({
        business,
        from: call.from,
        to: call.to,
        providerCallSid: call.callSid,
      }),
    ),
  );

  if (activate) {
    await Promise.all(
      contexts.map((context, index) => {
        const call = calls[index];
        return VoiceSessionService.activateFromSetup({
          voiceSessionId: context._id,
          setup: {
            callSid: call.callSid,
            sessionId: call.providerSessionId,
            accountSid: "AC00000000000000000000000000000000",
            from: call.from,
            to: call.to,
            direction: "inbound",
            callType: "PSTN",
            customParameters: { businessId: String(business._id) },
          },
        });
      }),
    );
  }

  return Promise.all(
    calls.map((call) =>
      VoiceSession.findOne({
        business: business._id,
        providerCallSid: call.callSid,
      }),
    ),
  );
};

export const appendSentinelTurn = async ({ session, call }) => {
  await VoiceTranscriptService.append({
    sessionId: session._id,
    role: "customer",
    text: `${call.sentinel} customer turn for ${call.service}`,
  });
  await VoiceTranscriptService.append({
    sessionId: session._id,
    role: "assistant",
    text: `CALL=${call.callSid} SESSION=${session._id} ECHO=${call.sentinel}`,
  });
};

export const acquireAll = ({ business, sessions }) =>
  Promise.all(
    sessions.map((session) =>
      acquireVoiceCapacity({
        business,
        session,
        settings: business.voiceSettings || {},
      }),
    ),
  );

export const releaseAll = ({ business, sessions }) =>
  Promise.all(
    sessions.map((session) =>
      releaseVoiceCapacity({ businessId: business._id, session }),
    ),
  );
