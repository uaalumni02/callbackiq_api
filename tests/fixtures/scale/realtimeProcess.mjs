import { createServer } from 'node:http';
import { Server } from 'socket.io';
import SocketService from '../../../src/services/socket.service.js';
import { initializeSocketRedisAdapter, closeSocketRedisAdapter } from '../../../src/services/socketRedisAdapter.service.js';
const http = createServer();
const io = new Server(http, { transports: ['websocket'] });
await initializeSocketRedisAdapter(io);
SocketService.initialize(io);
// Synthetic fixture authentication only; the production middleware has
// separate session/tenant tests. Never used by a deployed entrypoint.
io.use(async (socket, next) => {
  if (socket.handshake.auth.token !== process.env.SCALE_TEST_TOKEN) return next(new Error('unauthorized'));
  await socket.join('business:synthetic'); await socket.join('user:synthetic'); next();
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
process.send({ ready: true, port: http.address().port });
process.on('message', async message => {
  if (message.type === 'emit') SocketService.emitMessageCreated('synthetic', { body: 'synthetic event', id: message.id });
  if (message.type === 'revoke') io.in('user:synthetic').disconnectSockets(true);
  if (message.type === 'close') {
    await new Promise(resolve => io.close(resolve)); await closeSocketRedisAdapter(); process.exit(0);
  }
});
