// External diagnostics retain the failure description, never embedded payloads or credentials.
export const redactErrorMessage = value => String(value || 'Unknown error')
  .replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [redacted]')
  .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
  .replace(/https?:\/\/[^\s<>"']+/gi, text => {
    try { const url = new URL(text); return `${url.origin}${url.pathname}`; }
    catch { return '[redacted URL]'; }
  })
  .replace(/\{[\s\S]*\}|\[[\s\S]*\]/g, '[redacted data]')
  .replace(/\b(?:authorization|cookie|password|secret|token|api[_-]?key|credential|request[_ ]?body|response[_ ]?body|payload|transcript|address|email|customer[_ ]?name)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^,;\n]*)/gi, '[redacted field]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
  .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted phone]')
  .replace(/"[^"\n]*"|'[^'\n]*'/g, '[redacted value]')
  .replace(/[\r\n\t]+/g, ' ')
  .slice(0, 300);

export const safeErrorType = value => /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(String(value || '')) ? String(value) : 'Error';
export const errorType = error => {
  const constructorName = error?.constructor?.name;
  return safeErrorType(constructorName && !['Object', 'Error'].includes(constructorName) ? constructorName : error?.name || constructorName);
};
export const safeErrorCode = value => /^[A-Za-z0-9_.:-]{1,80}$/.test(String(value ?? '')) ? String(value) : null;
