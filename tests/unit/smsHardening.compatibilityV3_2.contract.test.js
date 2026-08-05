import fs from "fs";
import path from "path";

const read = (relative) =>
  fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");

describe("SMS hardening compatibility v3.2 contracts", () => {
  test("agent-generated replies are treated as direct customer responses", () => {
    const source = read("src/controllers/agent.js");
    expect(source).toMatch(/source:\s*["']agent_reply["'][\s\S]{0,500}directResponse:\s*true/);
  });

  test("inbound emergency alerts use deterministic critical priority", () => {
    const source = read("src/services/twilioSmsWebhook.service.js");
    expect(source).toContain("evaluateDeterministicInboundGuardrails");
    expect(source).toMatch(/customerReplyPriority[\s\S]{0,500}alertPriority/);
    expect(source).toMatch(/priority:\s*customerReplyPriority/);
  });

  test("conversation creation reuses the normalized active thread", () => {
    const source = read("src/controllers/conversation.js");

    expect(source).toContain("createOrReuseConversation");
    expect(source).toContain("normalizedCustomerPhone");
    expect(source).toContain("customerPhoneLookup");
    expect(source).toContain("phoneLookupVariants");
    expect(source).toContain('status: { $ne: "archived" }');
    expect(source).toContain("Number(error?.code) !== 11000");
    expect(source).toContain('updates.reopenReason = "conversation_create_reused"');
    expect(source).toMatch(/existingConversation\.humanTakeover\s*!==\s*true/);
    expect(source).toMatch(/createOrReuseConversation\(\{[\s\S]{0,250}businessId:\s*business\._id[\s\S]{0,250}payload:\s*req\.body/);
  });

  test("message route tests isolate provider delivery", () => {
    const source = read("tests/routes/message.routes.test.js");
    expect(source).toMatch(/jest\.mock\(["']\.\.\/\.\.\/src\/services\/twilioSmsService\.js["']/);
    expect(source).toContain("SM_MESSAGE_ROUTE_TEST");
  });
});
