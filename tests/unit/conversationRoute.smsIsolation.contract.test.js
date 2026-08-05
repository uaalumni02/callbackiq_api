import fs from "fs";
import path from "path";

const read = (relativePath) =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("conversation route SMS test isolation", () => {
  test("uses unique provider SIDs and preserves the actual pre-archive workflow state", () => {
    const source = read("tests/routes/conversation.routes.test.js");

    expect(source).toContain("CALLBACKIQ_CONVERSATION_ROUTE_SMS_MOCK");
    expect(source).toContain('../../src/services/twilioSmsService.js');
    expect(source).toContain("let sequence = 0");
    expect(source).toContain("SM_CONVERSATION_ROUTE_TEST_${++sequence}");
    expect(source).not.toContain('sid: "SM_CONVERSATION_ROUTE_TEST"');
    expect(source).toContain("suppressed: false");
    expect(source).toContain("segmentCount: 1");

    expect(source).toMatch(
      /expect\(savedConversation\.archiveSnapshot\)[\s\S]*?aiEnabled:\s*false[\s\S]*?humanTakeover:\s*true/,
    );
    expect(source).toContain(
      "expect(restoreRes.body.data.aiEnabled).toBe(false);",
    );
    expect(source).toContain(
      "expect(restoreRes.body.data.humanTakeover).toBe(true);",
    );
  });
});
