const MAX_BYTES = 5 * 1024 * 1024;
const active = new Map();
let totalActive = 0;
const failure = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });
export function allowedMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') &&
      (u.hostname === 'api.twilio.com' || u.hostname.endsWith('.twilio.com') || u.hostname.endsWith('.twiliocdn.com'));
  } catch { return false; }
}
async function fetchProvider(url, authorization, signal, fetcher) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedMediaUrl(url)) throw failure('Media redirect is not allowed.');
    const response = await fetcher(url, { redirect: 'manual', signal,
      headers: new URL(url).hostname === 'api.twilio.com' ? { Authorization: authorization } : {} });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw failure('Media redirect is missing its destination.');
    url = new URL(location, url).href;
  }
  throw failure('Too many media redirects.');
}
async function readBounded(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel(); throw failure('Media exceeds the 5 MiB limit.', 413);
  }
  if (!response.body) throw failure('Media response has no body.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw failure('Media exceeds the 5 MiB limit.', 413);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export async function loadProviderMedia({ url, authorization, businessId, req, res, fetcher = fetch, timeoutMs = 10000 }) {
  const key = String(businessId), count = active.get(key) || 0;
  if (count >= 2 || totalActive >= 8) throw failure('Media downloads are busy. Retry shortly.', 429);
  active.set(key, count + 1); totalActive++;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  req?.once('aborted', cancel); res?.once('close', cancel);
  try {
    const upstream = await fetchProvider(url, authorization, controller.signal, fetcher);
    if (!upstream.ok) { await upstream.body?.cancel(); throw failure('Media is unavailable.', upstream.status === 404 ? 404 : 502); }
    const buffer = await readBounded(upstream, controller.signal);
    return { buffer, contentType: upstream.headers.get('content-type') || 'application/octet-stream' };
  } finally {
    clearTimeout(timer); req?.off('aborted', cancel); res?.off('close', cancel);
    const remaining = (active.get(key) || 1) - 1;
    if (remaining) active.set(key, remaining); else active.delete(key);
    totalActive--;
  }
}
