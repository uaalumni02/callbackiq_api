import { numericSetting } from "../../config/numericSettings.js";
const timedOut = () =>
  Object.assign(
    new Error("Google request exceeded its application deadline."),
    { code: "GOOGLE_PROVIDER_TIMEOUT", statusCode: 503 },
  );
const abortable = (operation, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(timedOut());
      return;
    }
    const stop = () => reject(timedOut());
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
/** Bounds every Google exchange and response-body read; upstream cancellation and timeouts fail closed. */
export async function googleHttpRequest(url, options = {}, transport = fetch) {
  const deadline = AbortSignal.timeout(
    numericSetting("PILOT_GOOGLE_REQUEST_TIMEOUT_MS"),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  const response = await abortable(
    transport(url, { ...options, signal }),
    signal,
  );
  return new Proxy(response, {
    get(target, key) {
      if (["json", "text", "arrayBuffer"].includes(key))
        return () => abortable(target[key](), signal);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
