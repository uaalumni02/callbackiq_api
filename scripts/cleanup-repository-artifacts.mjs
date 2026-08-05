#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const candidates = [
  ".callbackiq-phase9-backup",
  "tools/api_overlay",
  "tools/frontend_overlay",
  "src/voice/conversationRelay.server.server.js.backup-20260803-154705",
  "src/voice/voiceAgent.service.js.backup-before-human-request-hotfix",
  "scripts/verify-phase9-frontend.js.backup",
  "src/components/settings/voice/__tests__/VoiceAiSettingsPanel.test.jsx.bak",
];

const existing = candidates
  .map((relative) => ({ relative, absolute: path.join(root, relative) }))
  .filter(({ absolute }) => fs.existsSync(absolute));

for (const item of existing) {
  console.log(`${apply ? "REMOVE" : "WOULD REMOVE"}: ${item.relative}`);
  if (apply) fs.rmSync(item.absolute, { recursive: true, force: true });
}

const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  console.log("NOTICE: .env exists locally and was not deleted. Confirm it is ignored and not tracked with: git ls-files --error-unmatch .env");
}
console.log(JSON.stringify({ applied: apply, artifacts: existing.map((item) => item.relative) }, null, 2));
