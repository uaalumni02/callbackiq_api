import { PATH, validateConversationRelaySignature } from "../conversationRelaySignature.js";

{ validateConversationRelaySignature };

import { withDeadline } from "../../services/boundedRedis.service.js";

import { runVoiceConversationTurn } from '../../services/voiceConversationTurn.service.js';

import { createVoiceAdmission, acquireFleetVoiceSlot } from "../../services/voiceAdmission.service.js";

import { registerVoiceSnapshot } from "../../services/runtimeState.service.js";

import { WebSocket, WebSocketServer } from "ws";

import VoiceAgentService from "../voiceAgent.service.js";

import VoiceFailureService from "../voiceFailure.service.js";

import VoiceSessionService from "../voiceSession.service.js";

import VoiceTranscriptService from "../voiceTranscript.service.js";

import VoiceOutcomeService from "../voiceOutcome.service.js";

import VoiceMetricsService from "../voiceMetrics.service.js";

import {
  isPhase9ForcedRelayFailureEnabled,
  normalizeVoiceSettings,
} from "../voiceRouting.service.js";

import {
  isTransientDependencyError,
  sanitizeDtmfDigits,
  toSpokenReply,
} from "../voiceInput.service.js";

import {
  determineVoiceFailureRoute,
  VOICE_ROUTE,
} from "../voiceRoutingPolicy.service.js";

import VoiceCapacityService from "../../services/voiceCapacity.service.js";

import VoiceUsageService from "../../services/voiceUsage.service.js";

import VoiceFraudDetectionService from "../../services/voiceFraudDetection.service.js";

import VoiceConnectionLeaseService from "../../services/voiceConnectionLease.service.js";

import { resolveTrustedRemoteAddress } from "../../services/trustedProxyAddress.service.js";

import { runWithVoiceTurnContext } from "../../services/voiceTurnContext.service.js";

import { sanitizeUnverifiedStaffCommitments } from "../../services/customerCommitmentSafety.service.js";

import {
  logOperationalError,
  logOperationalWarning,
} from "../../helpers/logging/safeLogger.js";

const DEFAULT_END_DELAY_MS = 700;

const DEFAULT_CLOSE_DELAY_MS = 3500;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const DEFAULT_IDLE_FIRST_MS = 15_000;

const DEFAULT_IDLE_SECOND_MS = 30_000;

const DEFAULT_IDLE_END_MS = 45_000;

const DEFAULT_SOFT_TURN_TIMEOUT_MS = 2_500;

const DEFAULT_HARD_TURN_TIMEOUT_MS = 15_000;

const DEFAULT_MAX_PENDING_PER_IP = 5;

const DEFAULT_MAX_CALL_DURATION_SECONDS = 600;

const DEFAULT_DURATION_WARNING_SECONDS = 60;

const MAX_FRAME_BYTES = 64 * 1024;

const RECOVERABLE_RELAY_ERROR_CODES = new Set([
  "64106",
  "64107",
  "64111",
  "64112",
]);

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return timer;
};

const rejectUpgrade = (socket, statusCode, message) => {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
};

const remoteAddress = (request) =>
  String(
    request.headers?.["x-forwarded-for"]?.split(",")[0] ||
      request.socket?.remoteAddress ||
      "unknown",
  )
    .trim()
    .slice(0, 100);

const safeSend = (socket, payload) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    logOperationalError("conversation_relay.send_failed", error);
    return false;
  }
};

const getMaximumDurationSeconds = (session) =>
  boundedInteger(
    session?.business?.voiceSettings?.maxCallDurationSeconds ??
      process.env.DEFAULT_VOICE_MAX_DURATION_SECONDS,
    DEFAULT_MAX_CALL_DURATION_SECONDS,
    60,
    DEFAULT_MAX_CALL_DURATION_SECONDS,
  );

const createTurnTimeoutError = () => {
  const error = new Error(
    "The voice turn exceeded the maximum dependency-response window.",
  );
  error.code = "VOICE_TURN_TIMEOUT";
  return error;
};

const extractRelayErrorCode = (message) =>
  String(
    message?.code ||
      message?.errorCode ||
      String(message?.description || "").match(/\b(641\d{2})\b/)?.[1] ||
      "",
  );
export { DEFAULT_CLOSE_DELAY_MS, DEFAULT_DURATION_WARNING_SECONDS, DEFAULT_END_DELAY_MS, DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_HARD_TURN_TIMEOUT_MS, DEFAULT_IDLE_END_MS, DEFAULT_IDLE_FIRST_MS, DEFAULT_IDLE_SECOND_MS, DEFAULT_MAX_CALL_DURATION_SECONDS, DEFAULT_MAX_PENDING_PER_IP, DEFAULT_SOFT_TURN_TIMEOUT_MS, MAX_FRAME_BYTES, PATH, RECOVERABLE_RELAY_ERROR_CODES, VOICE_ROUTE, VoiceAgentService, VoiceCapacityService, VoiceConnectionLeaseService, VoiceFailureService, VoiceFraudDetectionService, VoiceMetricsService, VoiceOutcomeService, VoiceSessionService, VoiceTranscriptService, VoiceUsageService, WebSocket, WebSocketServer, acquireFleetVoiceSlot, boundedInteger, createTurnTimeoutError, createVoiceAdmission, determineVoiceFailureRoute, extractRelayErrorCode, getMaximumDurationSeconds, isPhase9ForcedRelayFailureEnabled, isTransientDependencyError, logOperationalError, logOperationalWarning, normalizeVoiceSettings, registerVoiceSnapshot, rejectUpgrade, remoteAddress, resolveTrustedRemoteAddress, runVoiceConversationTurn, runWithVoiceTurnContext, safeSend, sanitizeDtmfDigits, sanitizeUnverifiedStaffCommitments, schedule, toSpokenReply, validateConversationRelaySignature, withDeadline };
