import definitions from '../../config/worker-settings.json' with { type: 'json' };

export function workerSetting(name, env = process.env) {
  const definition = definitions[name];
  if (!definition) throw new Error(`Unknown worker setting ${name}`);
  if (env[name] === undefined || env[name] === '') return definition.default;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < definition.min || value > definition.max) {
    throw Object.assign(new Error(`${name} must be an integer from ${definition.min} to ${definition.max}`), { code: 'INVALID_WORKER_SETTING' });
  }
  return value;
}
export function validateWorkerSettings(env = process.env) {
  for (const name of Object.keys(definitions)) workerSetting(name, env);
}
