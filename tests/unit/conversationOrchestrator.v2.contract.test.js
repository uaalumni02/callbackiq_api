import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("Conversation Orchestration v2 contract", () => {
  test("persists structured memory and prevents silent inbound termination", () => {
    const orchestrator = read("src/services/conversationOrchestrator.service.js");
    const conversation = read("src/models/conversation.js");
    const message = read("src/models/message.js");
    expect(orchestrator).toMatch(/silent_failure_guard/);
    expect(orchestrator).toMatch(/conversationMemory/);
    expect(conversation).toMatch(/silentFailureCount/);
    expect(message).toMatch(/aiOutcome/);
  });

  test("booking recognizes natural-language availability and negotiates alternatives", () => {
    const booking = read("src/services/booking/bookingStateMachine.service.js");
    expect(booking).toMatch(/AVAILABILITY_HINT/);
    expect(booking).toMatch(/scheduling_no_match_after_three_attempts/);
    expect(booking).toMatch(/Which works best/);
  });
});
