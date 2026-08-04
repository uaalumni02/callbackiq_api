import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");

test("completion callbacks are find-only and cannot fabricate CRM records", async () => {
  const source = await read("src/controllers/voiceWebhook.js");
  assert.equal(
    (source.match(/VoiceSessionService\.ensureContext\(/g) || []).length,
    1,
  );
  assert.match(source, /static async overflow[\s\S]*findExistingContext\(req\)/);
  assert.match(source, /static async complete[\s\S]*findExistingContext\(req\)/);
  assert.match(
    source,
    /static async transferComplete[\s\S]*findExistingContext\(req\)/,
  );
});

test("completion metadata is merged rather than replaced", async () => {
  const source = await read("src/voice/voiceSession.service.js");
  assert.match(source, /sanitizeMetadata/);
  assert.match(source, /\.\.\.sanitizeMetadata\(metadata\)/);
  assert.doesNotMatch(source, /\$set:\s*\{[^}]*metadata:\s*metadata/s);
});

test("transport has bounded setup, silence, turn and call timers", async () => {
  const source = await read("src/voice/conversationRelay.server.js");
  for (const token of [
    "DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000",
    "DEFAULT_IDLE_FIRST_MS = 15_000",
    "DEFAULT_IDLE_SECOND_MS = 30_000",
    "DEFAULT_IDLE_END_MS = 45_000",
    "DEFAULT_HARD_TURN_TIMEOUT_MS = 15_000",
    "DEFAULT_MAX_CALL_DURATION_SECONDS = 600",
  ]) {
    assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("capacity leases cannot inherit legacy one-hour durations", async () => {
  const source = await read("src/services/voiceCapacity.service.js");
  assert.match(source, /VOICE_CAPACITY_MAX_DURATION_SECONDS = 600/);
  assert.match(source, /sweepExpiredVoiceCapacity/);
  assert.doesNotMatch(source, /7200/);
});

test("timeouts do not launch a concurrent duplicate agent turn", async () => {
  const source = await read("src/voice/conversationRelay.server.js");
  assert.match(source, /error\?\.code !== "VOICE_TURN_TIMEOUT"/);
  assert.match(source, /DEFAULT_SOFT_TURN_TIMEOUT_MS = 2_500/);
  assert.match(source, /DEFAULT_HARD_TURN_TIMEOUT_MS = 15_000/);
});

test("dialogue guards bound fallback loops, language barriers and abuse", async () => {
  const source = await read("src/voice/voiceAgent.service.js");
  assert.match(source, /MAX_UNMATCHED_TURNS_BEFORE_CALLBACK\s*=\s*4/);
  assert.match(
    source,
    /fallbackTurnCount\s*>=\s*MAX_UNMATCHED_TURNS_BEFORE_CALLBACK/,
  );
  assert.match(source, /MAX_ABUSIVE_TURNS = 2/);
  assert.match(source, /reason:\s*"language_barrier_spanish"/);
});

test("callback capture uses readback, corrections and two-attempt field limits", async () => {
  const source = await read("src/voice/voiceCallback.service.js");
  assert.match(source, /awaiting_confirmation/);
  assert.match(source, /Is that correct\? Say yes/);
  assert.match(source, /retryCounts\[field\] >= 2/);
  assert.match(source, /parseCorrection/);
});
