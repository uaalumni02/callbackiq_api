import test from 'node:test';
import { behavioralContract } from './support/behavioralContract.mjs';

test("completion callbacks are find-only and cannot fabricate CRM records", () => behavioralContract(["tests/integration/providerBoundaries.behavior.test.js"]));
test("completion metadata is merged rather than replaced", () => behavioralContract(["tests/integration/providerBoundaries.behavior.test.js"]));
test("transport has bounded setup, silence, turn and call timers", () => behavioralContract(["tests/unit/conversationRelay.server.test.js", "tests/unit/communicationSafety.voiceRelayLimits.test.js"]));
test("capacity leases cannot inherit legacy one-hour durations", () => behavioralContract(["tests/unit/communicationSafety.voiceCapacity.test.js"]));
test("timeouts do not launch a concurrent duplicate agent turn", () => behavioralContract(["tests/unit/conversationRelay.server.test.js"]));
test("dialogue guards bound fallback loops, language barriers and abuse", () => behavioralContract(["tests/unit/voiceAgent.service.test.js"]));
test("callback capture uses readback, corrections and two-attempt field limits", () => behavioralContract(["tests/integration/voiceCustomerOutcome.persistence.test.js", "tests/unit/voiceCallback.service.test.js"]));
