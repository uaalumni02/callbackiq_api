/** Normalize emergency-number pronunciation only at voice output boundaries.
 * Words avoid providers interpreting numeric 911 as a cardinal number.
 * Keep shared intake/SMS text unchanged.
 */
export const normalizeEmergencyNumberForSpeech = (value) =>
  String(value ?? "").replace(/(?<![\w+-])9(?:[ \t-]?1){2}(?![\w-])/g, "nine one one");
