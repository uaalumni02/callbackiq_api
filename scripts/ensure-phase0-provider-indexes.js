import fs from "fs";
import path from "path";

const root = process.cwd();

const configurations = [
  {
    file: "src/models/message.js",
    schemaName: "MessageSchema",
    modelDeclaration: /const\s+Message\s*=/,
    providerCandidates: ["providerMessageId", "providerMessageSid"],
    marker: "CALLBACKIQ_PHASE0_CANONICAL_MESSAGE_PROVIDER_INDEX",
  },
  {
    file: "src/models/callLog.js",
    schemaName: "CallLogSchema",
    modelDeclaration: /const\s+CallLog\s*=/,
    providerCandidates: ["providerCallId", "providerCallSid"],
    marker: "CALLBACKIQ_PHASE0_CANONICAL_CALL_PROVIDER_INDEX",
  },
];

const detectProviderField = (source, candidates) =>
  candidates.find((candidate) =>
    new RegExp(`\\b${candidate}\\s*:`).test(source),
  );

const hasCanonicalIndex = ({ source, schemaName, providerField, marker }) => {
  if (source.includes(marker)) return true;

  const compact = source.replace(/\s+/g, " ");
  const exactIndexPattern = new RegExp(
    `${schemaName}\\.index\\(\\s*\\{\\s*business\\s*:\\s*1\\s*,\\s*${providerField}\\s*:\\s*1\\s*\\}\\s*,\\s*\\{[^}]*unique\\s*:\\s*true`,
  );
  return exactIndexPattern.test(compact);
};

const buildIndex = ({ schemaName, providerField, marker }) => `
/* ${marker}
 * Twilio retries must not create two records for the same provider event
 * within one business. The partial filter avoids indexing manual/system
 * records whose provider identifier is blank.
 */
${schemaName}.index(
  { business: 1, ${providerField}: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ${providerField}: { $type: "string", $gt: "" },
    },
  },
);

`;

let changed = 0;

for (const configuration of configurations) {
  const absolutePath = path.join(root, configuration.file);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Required model file is missing: ${configuration.file}`);
  }

  const source = fs.readFileSync(absolutePath, "utf8");
  const providerField = detectProviderField(
    source,
    configuration.providerCandidates,
  );

  if (!providerField) {
    throw new Error(
      `${configuration.file} does not define any supported provider identifier: ${configuration.providerCandidates.join(", ")}`,
    );
  }

  if (
    hasCanonicalIndex({
      source,
      schemaName: configuration.schemaName,
      providerField,
      marker: configuration.marker,
    })
  ) {
    console.log(`Verified canonical provider index: ${configuration.file}`);
    continue;
  }

  const match = configuration.modelDeclaration.exec(source);
  if (!match || typeof match.index !== "number") {
    throw new Error(
      `Could not find the model declaration insertion point in ${configuration.file}`,
    );
  }

  const updated =
    source.slice(0, match.index) +
    buildIndex({
      schemaName: configuration.schemaName,
      providerField,
      marker: configuration.marker,
    }) +
    source.slice(match.index);

  fs.writeFileSync(absolutePath, updated);
  changed += 1;
  console.log(`Added canonical provider index: ${configuration.file}`);
}

console.log(
  changed
    ? `Phase 0 provider-index enforcement updated ${changed} model file(s).`
    : "Phase 0 provider indexes already satisfy the canonical contract.",
);
