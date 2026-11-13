import fs from "node:fs";
import { parse } from "@babel/parser";
import { conversationIntelligenceSchema } from "../../src/services/conversationIntelligence.schema.js";

test("the policy imports only the pure shared contract and cannot access runtime effects", () => {
  const source = fs.readFileSync("src/services/conversationIntelligenceNormalization.policy.js", "utf8");
  const ast = parse(source, { sourceType: "module" });
  expect(ast.program.body.filter(node => node.type === "ImportDeclaration").map(node => node.source.value))
    .toEqual(["./conversationIntelligence.contract.js"]);
  const forbidden = new Set(["process", "Date", "console", "global", "globalThis", "fetch", "require", "setTimeout", "setInterval"]);
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier") expect(forbidden.has(node.name)).toBe(false);
    expect(node.type).not.toBe("ImportExpression");
    if (node.type === "CallExpression") expect(node.callee?.type).not.toBe("Import");
    if (node.type === "MemberExpression" && node.object.name === "Math") expect(node.property.name).not.toBe("random");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && value.type) visit(value);
    }
  };
  visit(ast.program);
  const contract = parse(fs.readFileSync("src/services/conversationIntelligence.contract.js", "utf8"), { sourceType: "module" });
  expect(contract.program.body.some(node => node.type === "ImportDeclaration")).toBe(false);
  visit(contract.program);
});

test("the extracted provider schema equals the frozen pre-extraction JSON fixture", () => {
  expect(conversationIntelligenceSchema).toEqual(JSON.parse(fs.readFileSync("tests/fixtures/conversationIntelligence/provider-schema.json", "utf8")));
});
