// Do not await or wrap the native result: callers own guard timing and error handling.
// The receiver, attached session, validation/save hooks and explicit save options survive.
export function saveStateDocument(document, ...options) {
  return document.save(...options);
}

export function saveOptionalStateDocument(document, ...options) {
  return document.save?.(...options);
}
