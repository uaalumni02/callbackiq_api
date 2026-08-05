const integerField = ({ minimum, maximum, defaultValue, label, help }) => ({
  type: "integer",
  minimum,
  maximum,
  defaultValue,
  label,
  help,
});

const allowedVoiceNames = (currentVoiceName = "") => {
  const configured = String(process.env.VOICE_ALLOWED_NAMES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const current = String(currentVoiceName || "").trim();
  return ["", ...new Set([...configured, ...(current ? [current] : [])])];
};

export const getVoiceSettingsSchema = ({ currentVoiceName = "" } = {}) => ({
  version: 1,
  fields: {
    overflowRingSeconds: integerField({
      minimum: 15,
      maximum: 25,
      defaultValue: 20,
      label: "Staff ring time",
      help: "Seconds before the configured recovery route begins.",
    }),
    maxCallDurationSeconds: integerField({
      minimum: 60,
      maximum: 600,
      defaultValue: 600,
      label: "Maximum call duration",
      help: "Seconds before the assistant completes the call with a safe outcome.",
    }),
    maxConcurrentCalls: integerField({
      minimum: 1,
      maximum: 100,
      defaultValue: 3,
      label: "Concurrent AI calls",
      help: "Additional calls use the configured callback-first fallback.",
    }),
    dailyVoiceMinutes: integerField({
      minimum: 1,
      maximum: 100000,
      defaultValue: 240,
      label: "Daily voice allowance",
      help: "AI minutes allowed per UTC day.",
    }),
    monthlyVoiceMinutes: integerField({
      minimum: 1,
      maximum: 1000000,
      defaultValue: 4000,
      label: "Monthly voice allowance",
      help: "AI minutes allowed per UTC calendar month.",
    }),
    callerVelocityLimitPerHour: integerField({
      minimum: 1,
      maximum: 1000,
      defaultValue: 10,
      label: "Calls per caller per hour",
      help: "Limits repeated calling patterns without storing raw caller numbers.",
    }),
    welcomeGreeting: {
      type: "string",
      maximumLength: 300,
      defaultValue: "",
      label: "Welcome greeting",
      help: "The API always adds required automated-assistant disclosure.",
    },
    voiceName: {
      type: "enum",
      allowedValues: allowedVoiceNames(currentVoiceName),
      defaultValue: "",
      label: "ConversationRelay voice",
      help:
        "Only server-approved voice identifiers may be published. Configure VOICE_ALLOWED_NAMES to add approved values.",
    },
  },
  immutableSafetyRules: {
    recordingEnabled: false,
    disclosureRequired: true,
    liveTransferRequiresDedicatedNumber: true,
    staffAcceptanceRequired: true,
    maximumCallDurationSeconds: 600,
  },
  publishWorkflow: ["edit", "validate", "review", "publish", "monitor", "rollback"],
});

export const getVoiceSettingsContract = getVoiceSettingsSchema;

export const validateVoiceNameAgainstSchema = (voiceName, options = {}) => {
  const normalized = String(voiceName || "").trim();
  const allowedValues = getVoiceSettingsSchema(options).fields.voiceName.allowedValues;
  if (!allowedValues.includes(normalized)) {
    const error = new Error(
      "Select a server-approved ConversationRelay voice before publishing.",
    );
    error.code = "VOICE_NAME_NOT_APPROVED";
    error.statusCode = 400;
    throw error;
  }
  return normalized;
};

export const validateVoiceSettingsDraft = (settings = {}, options = {}) => {
  const schema = getVoiceSettingsSchema(options);
  const errors = [];
  const warnings = [];
  for (const [field, contract] of Object.entries(schema.fields)) {
    if (!Object.hasOwn(settings, field)) continue;
    const value = settings[field];
    if (contract.type === "integer") {
      if (value === "" || value === null || value === undefined) {
        errors.push({ field, code: "required", message: `${contract.label} is required.` });
        continue;
      }
      const parsed = Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < contract.minimum ||
        parsed > contract.maximum
      ) {
        errors.push({
          field,
          code: "out_of_range",
          message: `${contract.label} must be between ${contract.minimum} and ${contract.maximum}.`,
        });
      }
    }
    if (contract.type === "string" && String(value || "").length > contract.maximumLength) {
      errors.push({
        field,
        code: "too_long",
        message: `${contract.label} cannot exceed ${contract.maximumLength} characters.`,
      });
    }
    if (contract.type === "enum" && !contract.allowedValues.includes(String(value || "").trim())) {
      errors.push({
        field,
        code: "not_approved",
        message: `${contract.label} is not in the server-approved list.`,
      });
    }
  }
  if (settings.voiceOverageEnabled === true) {
    warnings.push({
      field: "voiceOverageEnabled",
      code: "financial_impact",
      message: "Paid voice overages are enabled and may increase provider costs.",
    });
  }
  if (settings.voiceHardCapEnabled === false) {
    warnings.push({
      field: "voiceHardCapEnabled",
      code: "hard_cap_disabled",
      message: "Hard voice allowance caps are disabled.",
    });
  }
  if (settings.answerMode === "always") {
    warnings.push({
      field: "answerMode",
      code: "always_ai",
      message: "Voice AI will answer every eligible call immediately.",
    });
  }
  return { valid: errors.length === 0, errors, warnings, schemaVersion: schema.version };
};

export default {
  getVoiceSettingsSchema,
  getVoiceSettingsContract,
  validateVoiceNameAgainstSchema,
  validateVoiceSettingsDraft,
};
