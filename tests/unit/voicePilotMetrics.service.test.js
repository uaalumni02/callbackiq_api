jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(() => ({
      select: () => ({
        lean: async () => [
          {
            outcome: "booked",
            metadata: {
              metricEvents: [
                { event: "time_to_first_audio_ms", value: 700 },
                { event: "full_turn_latency_ms", value: 1200 },
              ],
            },
          },
          {
            outcome: "callback_saved",
            metadata: {
              metricEvents: [
                { event: "time_to_first_audio_ms", value: 1500 },
              ],
            },
          },
          {
            outcome: "abandoned",
            metadata: {
              abandonmentSmsStatus: "sent",
              metricEvents: [
                { event: "abandonment_alert_latency_ms", value: 350 },
              ],
            },
          },
          { outcome: null, metadata: { metricEvents: [] } },
        ],
      }),
    })),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/voiceUsageLedger.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(() => ({
      lean: async () => [
        {
          twilioEstimatedCostCents: 300,
          openAiEstimatedCostCents: 100,
        },
      ],
    })),
  },
}));

import VoiceSession from "../../src/models/voiceSession.js";
import {
  getVoicePilotMetrics,
  recordVoiceMetric,
} from "../../src/voice/voiceMetrics.service.js";

test("returns outcome, recovery, latency, and unit-economics metrics", async () => {
  const result = await getVoicePilotMetrics({ businessId: "business-1" });

  expect(result.totalCalls).toBe(4);
  expect(result.outcomeContainmentRate).toBe(50);
  expect(result.committedOutcomeRate).toBe(75);
  expect(result.timeToFirstAudioMs.p95).toBe(1500);
  expect(result.abandonmentRecoverySmsSuccessRate).toBe(100);
  expect(result.callsWithoutCommittedOutcome).toBe(1);
  expect(result.costPerBookedJobCents).toBe(400);
  expect(result.costPerRecoveredLeadCents).toBe(200);
});


test("ignores non-persisted string fixture session IDs", async () => {
  VoiceSession.updateOne.mockClear();

  const result = await recordVoiceMetric({
    sessionId: "voice-session-1",
    event: "transfer_attempted",
  });

  expect(result).toEqual({
    recorded: false,
    reason: "non_persisted_session_id",
  });
  expect(VoiceSession.updateOne).not.toHaveBeenCalled();
});
