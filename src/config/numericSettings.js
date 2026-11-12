import additionalDefinitions from '../../config/numeric-settings.json' with { type: 'json' };
import workerDefinitions from '../../config/worker-settings.json' with { type: 'json' };

// All consumers use this parser. Blank input is absent; zero is never inferred.
export const numericDefinitions = Object.freeze(Object.fromEntries([...Object.entries(workerDefinitions).map(([name, definition]) => [name, Object.freeze({
  ...definition,
  zero: 'rejected',
  unit: name.endsWith('_MS') ? 'milliseconds' : 'jobs',
  errorCode: 'INVALID_WORKER_SETTING'
})]), ...Object.entries(additionalDefinitions).map(([name, definition]) => [name, Object.freeze(definition)])]));
export function numericSetting(name, env = process.env) {
  const definition = numericDefinitions[name];
  if (!definition) throw new TypeError(`Unknown numeric setting ${name}`);
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return definition.default;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || !definition.clamp && (value < definition.min || value > definition.max)) {
    throw Object.assign(new TypeError(`${name} must be an integer from ${definition.min} to ${definition.max}; blank uses ${definition.default}.`), {
      code: definition.errorCode || 'INVALID_NUMERIC_SETTING',
      setting: name
    });
  }
  if (value === 0 && definition.zero === 'default') return definition.default;
  return definition.clamp ? Math.min(definition.max, Math.max(definition.min, value)) : value;
}
export function validateNumericSettings(env = process.env) {
  const errors = [];
  for (const name of Object.keys(numericDefinitions)) try {
    numericSetting(name, env);
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.length) throw Object.assign(new TypeError(errors.join('\n')), {
    code: 'INVALID_NUMERIC_CONFIGURATION'
  });
}
