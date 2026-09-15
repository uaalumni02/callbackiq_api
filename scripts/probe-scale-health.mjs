// Run outside the application cluster. --page explicitly enables outbound paging.
import 'dotenv/config';
import { sendOpsEvent } from '../src/services/opsPaging.service.js';
const url = new URL('/api/admin/scale-health', process.env.SCALE_API_URL);
if (url.protocol !== 'https:') throw new Error('External health probes require HTTPS');
let healthy = false;
try {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${process.env.SCALE_ADMIN_TOKEN || ''}` } });
  const body = await response.json(); healthy = response.ok && body.data?.healthy === true;
} catch { /* A dead application or database must also fail the external probe. */ }
if (process.argv.includes('--page')) {
  await sendOpsEvent({ key: 'external-fleet-health', action: healthy ? 'resolve' : 'trigger', reason: 'external_health_probe' });
}
console.log(JSON.stringify({ healthy, checkedAt: new Date().toISOString() }));
if (!healthy) process.exitCode = 1;
