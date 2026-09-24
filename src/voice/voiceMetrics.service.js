import VoiceSession from "../models/voiceSession.js";
import VoiceUsageLedger from "../models/voiceUsageLedger.js";

const RESOLVED_OUTCOMES = new Set([
  "booked",
  "callback_saved",
  "transfer_accepted",
  "direct_answer_resolved",
  "safety_escalated",
  "wrong_number",
  "caller_declined",
  "opted_out",
]);

const percentile = (values, p) => {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

const rate = (numerator, denominator) =>
  denominator
    ? Number(((Number(numerator) / Number(denominator)) * 100).toFixed(1))
    : 0;

const boundedMetadata = (metadata) => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 20)
      .map(([key, value]) => [
        String(key).slice(0, 80),
        typeof value === "string" ? value.slice(0, 500) : value,
      ]),
  );
};


const normalizeSessionId = (value) =>
  value?._id || value?.id || value || null;

const isPersistedSessionId = (value) => {
  if (!value) return false;

  if (
    typeof value === "object" &&
    (
      value._bsontype === "ObjectId" ||
      typeof value.toHexString === "function"
    )
  ) {
    return true;
  }

  return /^[a-f\d]{24}$/i.test(String(value));
};

export const recordVoiceMetric = async ({
  sessionId,
  event,
  value = 1,
  metadata = {},
  at = new Date(),
}) => {
  const metric = String(event || "").trim().slice(0, 100);
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedSessionId || !metric) {
    return { recorded: false, reason: "session_and_event_required" };
  }

  // Completion and unit tests use readable string fixture IDs such as
  // "voice-session-1". They do not represent persisted MongoDB sessions.
  // Metrics are optional instrumentation and must never break the call path.
  if (!isPersistedSessionId(normalizedSessionId)) {
    return { recorded: false, reason: "non_persisted_session_id" };
  }

  const numericValue = Number(value);
  const result = await VoiceSession.updateOne(
    { _id: normalizedSessionId },
    {
      $push: {
        "metadata.metricEvents": {
          $each: [
            {
              event: metric,
              value: Number.isFinite(numericValue) ? numericValue : 1,
              metadata: boundedMetadata(metadata),
              at,
            },
          ],
          $slice: -500,
        },
      },
      $set: {
        [`metadata.metricLast.${metric}`]: {
          value: Number.isFinite(numericValue) ? numericValue : 1,
          at,
        },
      },
    },
  );
  return { recorded: Boolean(result?.acknowledged ?? true) };
};

export const reviewEmergencyClassification = async ({
  businessId,
  sessionId,
  classification,
  notes = "",
}) => {
  const event =
    classification === "false_positive"
      ? "emergency_false_positive"
      : classification === "false_negative"
        ? "emergency_false_negative"
        : classification === "correct"
          ? "emergency_correct"
          : "";
  if (!event) {
    const error = new Error("Invalid emergency review classification.");
    error.statusCode = 400;
    throw error;
  }
  const session = await VoiceSession.findOne({
    _id: sessionId,
    business: businessId,
  })
    .select("_id")
    .lean();
  if (!session) {
    const error = new Error("Voice session was not found for this business.");
    error.statusCode = 404;
    throw error;
  }
  await recordVoiceMetric({
    sessionId,
    event,
    metadata: { notes: String(notes || "").trim().slice(0, 1000) },
  });
  return { sessionId, classification };
};

export const getVoicePilotMetrics = async ({
  businessId,
  from = new Date(Date.now() - 30 * 86_400_000),
  to = new Date(),
}) => {
  const sessions = await VoiceSession.find({
    business: businessId,
    startedAt: { $gte: from, $lte: to },
  })
    .select(
      "outcome outcomeCommittedAt status appointment transferredToHuman fallbackSmsStatus metadata startedAt endedAt",
    )
    .lean();

  const total = sessions.length;
  const outcomeCount = (name) =>
    sessions.filter((session) => session.outcome === name).length;
  const committed = sessions.filter((session) => session.outcome).length;
  const resolved = sessions.filter((session) =>
    RESOLVED_OUTCOMES.has(session.outcome),
  ).length;
  const events = sessions.flatMap(
    (session) => session.metadata?.metricEvents || [],
  );
  const values = (name) =>
    events
      .filter((event) => event.event === name)
      .map((event) => event.value);

  const firstAudio = values("time_to_first_audio_ms");
  const fullTurn = values("full_turn_latency_ms");
  const transferAttempted = values("transfer_attempted").length;
  const transferAccepted = outcomeCount("transfer_accepted");
  const exitRequested = values("exit_requested").length;
  const exitHonored = values("exit_honored_one_turn").filter(
    (value) => Number(value) > 0,
  ).length;
  const fieldPrompts = values("field_prompted").length;
  const fieldReasks = values("field_reasked").length;

  const usage = await VoiceUsageLedger.find({
    business: businessId,
    periodType: "month",
    periodKey: {
      $gte: from.toISOString().slice(0, 7),
      $lte: to.toISOString().slice(0, 7),
    },
  }).lean();
  const costCents = usage.reduce(
    (sum, ledger) =>
      sum +
      Number(ledger.twilioEstimatedCostCents || 0) +
      Number(ledger.openAiEstimatedCostCents || 0),
    0,
  );

  const bookings = outcomeCount("booked");
  const recovered =
    bookings + outcomeCount("callback_saved") + transferAccepted;
  const abandoned = outcomeCount("abandoned");
  const abandonmentSmsSent = sessions.filter(
    (session) =>
      session.outcome === "abandoned" &&
      session.metadata?.abandonmentSmsStatus === "sent",
  ).length;

  return {
    range: { from, to },
    totalCalls: total,
    committedOutcomeRate: rate(committed, total),
    outcomeContainmentRate: rate(resolved, total),
    bookingRate: rate(bookings, total),
    callbackSavedRate: rate(outcomeCount("callback_saved"), total),
    transferAttempted,
    transferAccepted,
    transferAcceptanceRate: rate(transferAccepted, transferAttempted),
    directAnswerResolved: outcomeCount("direct_answer_resolved"),
    midFlowAbandonmentRate: rate(abandoned, total),
    abandonmentRecoverySmsSuccessRate: rate(
      abandonmentSmsSent,
      abandoned,
    ),
    abandonmentAlertLatencyMs: {
      p50: percentile(values("abandonment_alert_latency_ms"), 50),
      p95: percentile(values("abandonment_alert_latency_ms"), 95),
      p99: percentile(values("abandonment_alert_latency_ms"), 99),
    },
    timeToFirstAudioMs: {
      p50: percentile(firstAudio, 50),
      p95: percentile(firstAudio, 95),
      p99: percentile(firstAudio, 99),
    },
    fullTurnLatencyMs: {
      p50: percentile(fullTurn, 50),
      p95: percentile(fullTurn, 95),
      p99: percentile(fullTurn, 99),
    },
    reAskedFieldRate: rate(fieldReasks, fieldPrompts),
    exitHonoredInOneTurnRate: rate(exitHonored, exitRequested),
    emergencyReview: {
      correct: values("emergency_correct").length,
      falsePositive: values("emergency_false_positive").length,
      falseNegative: values("emergency_false_negative").length,
    },
    conversationCostCents: costCents,
    costPerBookedJobCents: bookings ? Math.round(costCents / bookings) : 0,
    costPerRecoveredLeadCents: recovered
      ? Math.round(costCents / recovered)
      : 0,
    callsWithoutCommittedOutcome: total - committed,
    outcomeCounts: Object.fromEntries(
      [
        "booked",
        "appointment_requested",
        "callback_saved",
        "transfer_accepted",
        "direct_answer_resolved",
        "safety_escalated",
        "wrong_number",
        "caller_declined",
        "opted_out",
        "abandoned",
        "technical_failure",
      ].map((outcome) => [outcome, outcomeCount(outcome)]),
    ),
    definitions: {
      outcomeContainmentRate:
        "Calls ending with a caller-useful resolved outcome; abandoned and technical-failure outcomes are excluded.",
      committedOutcomeRate:
        "Calls with any explicit terminal outcome, including abandonment and technical failure.",
      timeToFirstAudioMs:
        "Milliseconds from final caller input to the first acknowledgment or assistant audio token.",
    },
  };
};

export default {
  getVoicePilotMetrics,
  recordVoiceMetric,
  reviewEmergencyClassification,
};
