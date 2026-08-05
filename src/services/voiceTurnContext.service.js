import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

const staleError = () => {
  const error = new Error("The voice turn is no longer active; side effects were fenced.");
  error.code = "VOICE_STALE_TURN";
  error.statusCode = 409;
  return error;
};

export const runWithVoiceTurnContext = (context, handler) =>
  storage.run(context, handler);

export const getVoiceTurnContext = () => storage.getStore() || null;

export const assertVoiceTurnActive = () => {
  const context = getVoiceTurnContext();
  if (!context) return true;
  if (context.signal?.aborted || context.isActive?.() === false) throw staleError();
  return true;
};

export default {
  assertVoiceTurnActive,
  getVoiceTurnContext,
  runWithVoiceTurnContext,
};
