#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = scriptDir;
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const installDependencies = args.has("--install");
const explicitApi = (() => {
  const index = process.argv.indexOf("--api");
  return index >= 0 ? process.argv[index + 1] : null;
})();

const cwd = process.cwd();
const findApiRepo = () => {
  const candidates = [explicitApi, path.join(cwd, "callbackiq_api"), cwd].filter(Boolean);
  for (const candidate of candidates) {
    const packagePath = path.join(candidate, "package.json");
    if (!fs.existsSync(packagePath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (pkg.name === "callbackiq_api") return path.resolve(candidate);
    } catch {
      // Continue searching.
    }
  }
  throw new Error(
    "Could not locate callbackiq_api. Run this from the API repository root or pass --api /path/to/callbackiq_api.",
  );
};

const apiRoot = findApiRepo();
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const backups = [];
const changes = [];

const ensureParent = (filePath) =>
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

const backupFile = (filePath) => {
  if (!fs.existsSync(filePath)) return;
  const relative = path.relative(apiRoot, filePath);
  const backup = path.join(
    apiRoot,
    ".callbackiq-backups",
    `phase9-${timestamp}`,
    relative,
  );
  if (!dryRun) {
    ensureParent(backup);
    fs.copyFileSync(filePath, backup);
  }
  backups.push(backup);
};

const writeFile = (filePath, content) => {
  const current = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : null;
  if (current === content) return;
  backupFile(filePath);
  if (!dryRun) {
    ensureParent(filePath);
    fs.writeFileSync(filePath, content);
  }
  changes.push(path.relative(apiRoot, filePath));
};

const readRepoFile = (relative) => {
  const filePath = path.join(apiRoot, relative);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing expected file: ${filePath}`);
  }
  return { filePath, text: fs.readFileSync(filePath, "utf8") };
};

const saveRepoFile = (relative, original, next) => {
  if (original !== next) writeFile(path.join(apiRoot, relative), next);
};

const copyOverlay = () => {
  const overlayRoot = path.join(bundleRoot, "api_overlay");
  if (!fs.existsSync(overlayRoot)) {
    throw new Error(`Missing Phase 9 overlay directory: ${overlayRoot}`);
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(source);
      } else {
        const relative = path.relative(overlayRoot, source);
        writeFile(
          path.join(apiRoot, relative),
          fs.readFileSync(source, "utf8"),
        );
      }
    }
  };
  visit(overlayRoot);
};

const requireSingleMatch = (text, regex, label) => {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matches = [...text.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    throw new Error(
      `Refusing to patch ${label}: expected one compatible structure but found ${matches.length}.`,
    );
  }
  return matches[0];
};

const replaceSingle = (text, regex, replacement, label) => {
  requireSingleMatch(text, regex, label);
  return text.replace(regex, replacement);
};

const VOICE_SETTINGS_SCHEMA = `const VoiceSettingsSchema = new Schema(
  {
    answerMode: {
      type: String,
      enum: ["after_hours", "overflow", "always", "disabled"],
      default: "disabled",
    },
    overflowRingSeconds: { type: Number, min: 5, max: 60, default: 20 },
    transferPhone: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator(value) {
          if (!value) return true;
          return validate.isValidPhone(value);
        },
        message: "Please enter a valid voice transfer phone number",
      },
    },
    welcomeGreeting: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "Thanks for calling. How can I help you today?",
    },
    voiceName: { type: String, trim: true, maxlength: 200, default: "" },
    recordingEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

`;

const patchBusinessModel = () => {
  const relative = "src/models/business.js";
  const { text: original } = readRepoFile(relative);
  let text = original;

  if (!/const\s+VoiceSettingsSchema\s*=\s*new\s+Schema\s*\(/.test(text)) {
    const anchor = /const\s+BusinessSchema\s*=\s*new\s+Schema\s*\(/;
    requireSingleMatch(text, anchor, `${relative} VoiceSettingsSchema insertion`);
    text = text.replace(anchor, `${VOICE_SETTINGS_SCHEMA}$&`);
  }

  if (!/\bvoiceSettings\s*:\s*\{[\s\S]{0,300}?type\s*:\s*VoiceSettingsSchema\b/.test(text)) {
    const featuresBlock = /(\n\s{4}features\s*:\s*\{[\s\S]{0,350}?type\s*:\s*FeatureSettingsSchema\s*,[\s\S]{0,200}?\n\s{4}\},)/;
    if (featuresBlock.test(text)) {
      text = replaceSingle(
        text,
        featuresBlock,
        `$1\n    voiceSettings: {\n      type: VoiceSettingsSchema,\n      default: () => ({}),\n    },`,
        `${relative} voiceSettings field insertion`,
      );
    } else {
      const fallback = /\n(\s{4})aiKnowledge\s*:/;
      text = replaceSingle(
        text,
        fallback,
        `\n$1voiceSettings: {\n$1  type: VoiceSettingsSchema,\n$1  default: () => ({}),\n$1},\n$1aiKnowledge:`,
        `${relative} voiceSettings fallback insertion`,
      );
    }
  }

  saveRepoFile(relative, original, text);
};

const patchLeadModel = () => {
  const relative = "src/models/lead.js";
  const { text: original } = readRepoFile(relative);
  let text = original;
  const sourceBlock = /(\n\s{4}source\s*:\s*\{[\s\S]{0,450}?enum\s*:\s*\[)([^\]]*)(\])/;
  const match = requireSingleMatch(text, sourceBlock, `${relative} source enum`);
  const values = match[2];
  if (!/["']voice["']/.test(values)) {
    let updatedValues;
    if (/["']sms["']/.test(values)) {
      updatedValues = values.replace(/(["']sms["'])/, '$1, "voice"');
    } else if (/["']web["']/.test(values)) {
      updatedValues = values.replace(/(["']web["'])/, '"voice", $1');
    } else {
      updatedValues = `${values.trimEnd()}, "voice"`;
    }
    text = text.replace(sourceBlock, `$1${updatedValues}$3`);
  }
  saveRepoFile(relative, original, text);
};

const patchApp = () => {
  const relative = "src/app.js";
  const { text: original } = readRepoFile(relative);
  let text = original;

  if (!text.includes('import voiceSettingsRoutes from "./routes/voiceSettings.routes.js";')) {
    const preferred = /import\s+interventionRoutes\s+from\s+["']\.\/routes\/intervention\.routes\.js["'];/;
    if (preferred.test(text)) {
      text = replaceSingle(
        text,
        preferred,
        `$&\nimport voiceSettingsRoutes from "./routes/voiceSettings.routes.js";`,
        `${relative} voice settings import`,
      );
    } else {
      const fallback = /import\s+requestContext\s+from\s+["']\.\/middleware\/request-context\.js["'];/;
      text = replaceSingle(
        text,
        fallback,
        `import voiceSettingsRoutes from "./routes/voiceSettings.routes.js";\n$&`,
        `${relative} voice settings import fallback`,
      );
    }
  }

  if (!text.includes('app.use("/api/voice-settings", voiceSettingsRoutes);')) {
    const preferred = /app\.use\(\s*["']\/api\/interventions["']\s*,\s*interventionRoutes\s*\);/;
    if (preferred.test(text)) {
      text = replaceSingle(
        text,
        preferred,
        `$&\napp.use("/api/voice-settings", voiceSettingsRoutes);`,
        `${relative} voice settings route`,
      );
    } else {
      const fallback = /app\.get\(\s*["']\/["']/;
      text = replaceSingle(
        text,
        fallback,
        `app.use("/api/voice-settings", voiceSettingsRoutes);\n\n$&`,
        `${relative} voice settings route fallback`,
      );
    }
  }

  saveRepoFile(relative, original, text);
};

const patchServer = () => {
  const relative = "src/server.js";
  const { text: original } = readRepoFile(relative);
  let text = original;

  if (!text.includes('import { initializeConversationRelayServer } from "./voice/conversationRelay.server.js";')) {
    const preferred = /import\s*\{\s*startAutomationWorker\s*,\s*stopAutomationWorker\s*,?\s*\}\s*from\s*["']\.\/workers\/automation\.worker\.js["'];/;
    if (preferred.test(text)) {
      text = replaceSingle(
        text,
        preferred,
        `$&\nimport { initializeConversationRelayServer } from "./voice/conversationRelay.server.js";`,
        `${relative} ConversationRelay import`,
      );
    } else {
      const fallback = /const\s+port\s*=/;
      text = replaceSingle(
        text,
        fallback,
        `import { initializeConversationRelayServer } from "./voice/conversationRelay.server.js";\n\n$&`,
        `${relative} ConversationRelay import fallback`,
      );
    }
  }

  if (!/const\s+conversationRelayServer\s*=\s*initializeConversationRelayServer\(httpServer\)/.test(text)) {
    const anchor = /SocketService\.initialize\(io\);/;
    text = replaceSingle(
      text,
      anchor,
      `$&\nconst conversationRelayServer = initializeConversationRelayServer(httpServer);`,
      `${relative} ConversationRelay initialization`,
    );
  }

  if (!/await\s+conversationRelayServer\.close\(\);/.test(text)) {
    const anchor = /(^\s*)stopAutomationWorker\(\);/m;
    text = replaceSingle(
      text,
      anchor,
      `$&\n$1await conversationRelayServer.close();`,
      `${relative} ConversationRelay shutdown`,
    );
  }

  saveRepoFile(relative, original, text);
};

const patchTwilioRoutes = () => {
  const relative = "src/routes/twilio.routes.js";
  const { text: original } = readRepoFile(relative);
  let text = original;

  if (!text.includes('import VoiceWebhookController from "../controllers/voiceWebhook.js";')) {
    const anchor = /import\s+TwilioController\s+from\s+["']\.\.\/controllers\/twilio\.js["'];/;
    text = replaceSingle(
      text,
      anchor,
      `$&\nimport VoiceWebhookController from "../controllers/voiceWebhook.js";`,
      `${relative} voice webhook import`,
    );
  }

  if (!text.includes('VoiceWebhookController.initial')) {
    const voiceRoute = /router\.post\(\s*["']\/voice["']\s*,\s*validateTwilioSignature\s*,\s*TwilioController\.voiceWebhook\s*\);/;
    text = replaceSingle(
      text,
      voiceRoute,
      `router.post("/voice", validateTwilioSignature, VoiceWebhookController.initial);\nrouter.post("/voice-overflow", validateTwilioSignature, VoiceWebhookController.overflow);\nrouter.post("/voice-complete", validateTwilioSignature, VoiceWebhookController.complete);\nrouter.post("/voice-transfer-complete", validateTwilioSignature, VoiceWebhookController.transferComplete);`,
      `${relative} voice webhook routes`,
    );
  }

  saveRepoFile(relative, original, text);
};

const patchBookingStateMachine = () => {
  const relative = "src/services/booking/bookingStateMachine.service.js";
  const { text: original } = readRepoFile(relative);
  let text = original;

  if (!text.includes('channel = "sms"') || !text.includes("bookingIdempotencyPrefix")) {
    const handleSignature = /static\s+async\s+handle\s*\(\s*\{\s*business\s*,\s*lead\s*,\s*conversation\s*,\s*customerMessage\s*,?\s*\}\s*\)\s*\{/;
    text = replaceSingle(
      text,
      handleSignature,
      `static async handle({\n    business,\n    lead,\n    conversation,\n    customerMessage,\n    channel = "sms",\n    source = "booking_state_machine",\n  }) {\n    const bookingChannel = channel === "voice" ? "voice" : "sms";\n    const bookingSource = String(source || "booking_state_machine");\n    const bookingIdempotencyPrefix =\n      bookingChannel === "voice" ? "voice-" : "";\n    const bookingEventPrefix = bookingChannel === "voice" ? "voice:" : "";`,
      `${relative} handle signature`,
    );
  }

  if (!/bookingChannel\s*!==\s*["']voice["']\s*&&\s*!BOOKING_INTENT\.test\(text\)/.test(text)) {
    const intentCheck = /if\s*\(\s*!stateActive\s*&&\s*!BOOKING_INTENT\.test\(text\)\s*\)\s*\{/;
    text = replaceSingle(
      text,
      intentCheck,
      `if (\n      !stateActive &&\n      bookingChannel !== "voice" &&\n      !BOOKING_INTENT.test(text)\n    ) {`,
      `${relative} voice booking intent`,
    );
  }

  if (!/customerMessage:\s*text,\s*channel:\s*bookingChannel,\s*source:\s*bookingSource,/.test(text)) {
    const recursiveHandle = /(return\s+this\.handle\(\{[\s\S]{0,300}?customerMessage\s*:\s*text\s*,)(\s*\}\);)/;
    text = replaceSingle(
      text,
      recursiveHandle,
      `$1\n            channel: bookingChannel,\n            source: bookingSource,$2`,
      `${relative} recursive voice context`,
    );
  }

  const conversionAlreadyDynamic =
    /ConversionEventService\.record\(\{[\s\S]{0,500}?channel\s*:\s*bookingChannel\s*,[\s\S]{0,150}?source\s*:\s*bookingSource\s*,/.test(text);
  if (!conversionAlreadyDynamic) {
    const conversionChannel = /channel\s*:\s*["']sms["']\s*,\s*source\s*:\s*["']booking_state_machine["']\s*,/;
    text = replaceSingle(
      text,
      conversionChannel,
      `channel: bookingChannel,\n        source: bookingSource,`,
      `${relative} conversion channel`,
    );
  }

  if (!/source:\s*bookingChannel\s*,\s*bookedBy:\s*["']ai["']/.test(text)) {
    const bookingInputEnd = /(estimatedValue\s*:\s*lead\?\.estimatedValue\s*\|\|\s*0\s*,)(\s*\};)/;
    text = replaceSingle(
      text,
      bookingInputEnd,
      `$1\n          source: bookingChannel,\n          bookedBy: "ai",$2`,
      `${relative} appointment source`,
    );
  }

  if (!text.includes('`${bookingIdempotencyPrefix}ai-reschedule:')) {
    const rescheduleKey = /idempotencyKey\s*:\s*`ai-reschedule:/;
    text = replaceSingle(
      text,
      rescheduleKey,
      'idempotencyKey: `${bookingIdempotencyPrefix}ai-reschedule:',
      `${relative} reschedule idempotency`,
    );
  }

  if (!text.includes('`${bookingIdempotencyPrefix}ai-book:')) {
    const bookingKey = /idempotencyKey\s*:\s*`ai-book:/;
    text = replaceSingle(
      text,
      bookingKey,
      'idempotencyKey: `${bookingIdempotencyPrefix}ai-book:',
      `${relative} booking idempotency`,
    );
  }

  if (!text.includes('`${bookingEventPrefix}appointment_offered:')) {
    const offeredKey = /idempotencyKey\s*:\s*`appointment_offered:/;
    text = replaceSingle(
      text,
      offeredKey,
      'idempotencyKey: `${bookingEventPrefix}appointment_offered:',
      `${relative} offered-event idempotency`,
    );
  }

  if (!text.includes("Customer requested cancellation by ${bookingChannel}.")) {
    const cancelReason = /reason\s*:\s*["']Customer requested cancellation by SMS\.["']\s*,/;
    text = replaceSingle(
      text,
      cancelReason,
      'reason: `Customer requested cancellation by ${bookingChannel}.`,',
      `${relative} cancellation channel`,
    );
  }

  saveRepoFile(relative, original, text);
};

const patchPackage = () => {
  const packagePath = path.join(apiRoot, "package.json");
  const original = fs.readFileSync(packagePath, "utf8");
  const pkg = JSON.parse(original);
  pkg.dependencies ||= {};
  pkg.dependencies.ws = pkg.dependencies.ws || "^8.18.3";
  pkg.jest ||= {};
  const phase9OverlayIgnore = "<rootDir>/tools/api_overlay/";
  pkg.jest.testPathIgnorePatterns = Array.isArray(
    pkg.jest.testPathIgnorePatterns,
  )
    ? [...pkg.jest.testPathIgnorePatterns]
    : [];
  if (!pkg.jest.testPathIgnorePatterns.includes(phase9OverlayIgnore)) {
    pkg.jest.testPathIgnorePatterns.push(phase9OverlayIgnore);
  }

  pkg.scripts ||= {};
  pkg.scripts["verify:phase9:structure"] =
    "node scripts/verify-phase9-structure.js";
  pkg.scripts["test:phase9"] =
    "jest tests/unit/conversationRelay.server.test.js tests/unit/sendConfirmationSms.tool.test.js tests/unit/voiceAgent.service.test.js tests/unit/voiceRouting.service.test.js tests/unit/voiceSession.model.test.js tests/unit/voiceSessionFallback.service.test.js tests/unit/voiceSettings.controller.test.js tests/unit/voiceWebhook.controller.test.js tests/unit/voiceBookingStateMachineReuse.test.js tests/unit/safetyAssessmentService.voiceCompatibility.test.js --runInBand";
  pkg.scripts["certify:phase9"] =
    "npm run verify:phase9:structure && npm run test:phase0-8:completion && npm run test:phase9 && npm run build";
  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  if (next !== original) writeFile(packagePath, next);
};

copyOverlay();
patchBusinessModel();
patchLeadModel();
patchApp();
patchServer();
patchTwilioRoutes();
patchBookingStateMachine();
patchPackage();

if (dryRun) {
  console.log(`Phase 9 API dry run passed. ${changes.length} file(s) would be added or updated.`);
  console.log("No repository files were changed.");
} else {
  console.log(`Phase 9 API update applied. ${changes.length} file(s) added or updated.`);
  if (backups.length) {
    console.log(`Backups were written under .callbackiq-backups/phase9-${timestamp}.`);
  }
}

if (installDependencies && !dryRun) {
  console.log("Installing API dependencies and updating package-lock.json...");
  execFileSync("npm", ["install"], { cwd: apiRoot, stdio: "inherit" });
}

console.log("Next: run npm run certify:phase9 from the API repository root.");
