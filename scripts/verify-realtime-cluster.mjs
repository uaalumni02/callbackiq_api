import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { withDeadline } from '../src/services/boundedRedis.service.js';
let url = process.env.SCALE_TEST_REDIS_URL;
let redisProcess;
if (process.env.SCALE_TEST_REDIS_BIN) {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  redisProcess = spawn(process.env.SCALE_TEST_REDIS_BIN, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: ['ignore','pipe','inherit'] });
  await withDeadline(new Promise(resolve => redisProcess.stdout.on('data', data => { if (data.toString().includes('Ready to accept connections')) resolve(); })), 5000);
  url = `redis://127.0.0.1:${port}`;
}
if (!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw new Error('A dedicated local SCALE_TEST_REDIS_URL is required');
const token = crypto.randomUUID();
const env = { ...process.env, NODE_ENV: 'test', SOCKET_REDIS_URL: url, SOCKET_REDIS_REQUIRED: 'true', SOCKET_REDIS_CHANNEL_PREFIX: `test:${crypto.randomUUID()}`, SCALE_TEST_TOKEN: token };
const children = [];
let client;
try {
  for (let n = 0; n < 2; n++) {
    const child = fork(fileURLToPath(new URL('../tests/fixtures/scale/realtimeProcess.mjs', import.meta.url)), [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push(child);
    const [ready] = await withDeadline(once(child, 'message'), 10000, 'CHILD_READY_TIMEOUT');
    child.port = ready.port;
  }
  client = io(`http://127.0.0.1:${children[0].port}`, { transports: ['websocket'], auth: { token }, reconnection: false });
  await withDeadline(once(client, 'connect'), 5000);
  const delivery = withDeadline(once(client, 'message:created'), 5000);
  children[1].send({ type: 'emit', id: 'worker-reply' });
  const [payload] = await delivery;
  if (payload.id !== 'worker-reply') throw new Error('Worker event mismatch');
  const disconnect = withDeadline(once(client, 'disconnect'), 5000);
  children[1].send({ type: 'revoke' });
  await disconnect;
  console.log('PASS: worker event delivery and cross-process session revocation through real Redis.');
} finally {
  client?.disconnect();
  for (const child of children) { if (child.connected) child.send({ type: 'close' }); if (child.exitCode === null) await withDeadline(once(child, 'exit'), 3000).catch(() => child.kill()); }
  redisProcess?.kill();
}
