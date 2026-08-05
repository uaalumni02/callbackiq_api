import fs from "fs";
import path from "path";

const read = (relative) => fs.readFileSync(path.resolve(relative), "utf8");

describe("SMS hardening Mongoose 9 middleware contracts", () => {
  test.each([
    ["src/models/lead.js", "normalizeLeadPhone"],
    ["src/models/lead.js", "normalizeLeadPhoneUpdate"],
    ["src/models/conversation.js", "normalizeConversationIdentity"],
    ["src/models/conversation.js", "normalizeConversationUpdate"],
    ["src/models/message.js", "validateMessageContent"],
  ])("%s uses synchronous middleware for %s", (relative, functionName) => {
    const source = read(relative);
    expect(source).not.toMatch(
      new RegExp(`function\\s+${functionName}\\s*\\(\\s*next\\s*\\)`),
    );
  });

  test("lead and conversation queries normalize legacy phone filters", () => {
    expect(read("src/models/lead.js")).toContain("normalizeLeadPhoneFilter");
    expect(read("src/models/conversation.js")).toContain(
      "normalizeConversationPhoneFilter",
    );
  });
});
