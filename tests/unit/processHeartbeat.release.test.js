import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import Heartbeat from '../../src/models/processHeartbeat.js';
import { startProcessHeartbeat, stopProcessHeartbeat } from '../../src/services/processHeartbeat.service.js';
import { socketRedisReady } from '../../src/services/socketRedisAdapter.service.js';
jest.mock('../../src/services/socketRedisAdapter.service.js', () => ({ socketRedisReady: jest.fn(() => true) }));
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({ logOperationalError: jest.fn() }));
const savedEnv = { ...process.env };
beforeEach(() => {
 jest.useFakeTimers(); process.env.SCALE_PROFILE='business-1000-voice-350'; process.env.PROCESS_ROLE='worker-sms';
 mongoose.connection.readyState=1; socketRedisReady.mockReturnValue(true);
 jest.spyOn(fs,'writeFile').mockResolvedValue(); jest.spyOn(fs,'rename').mockResolvedValue();
 jest.spyOn(Heartbeat,'updateOne').mockReturnValue({ maxTimeMS: async () => ({}) });
});
afterEach(async () => { await stopProcessHeartbeat(); mongoose.connection.readyState=0; process.env={...savedEnv}; jest.restoreAllMocks(); jest.useRealTimers(); });
test('worker publishes bounded database heartbeat and atomic local readiness', async () => {
 startProcessHeartbeat(); await jest.advanceTimersByTimeAsync(1);
 expect(fs.rename).toHaveBeenCalled(); expect(Heartbeat.updateOne).toHaveBeenCalledTimes(1);
 startProcessHeartbeat(); await jest.advanceTimersByTimeAsync(10000); expect(Heartbeat.updateOne).toHaveBeenCalledTimes(2);
});
test('loss of Redis marks worker unready without advertising a healthy database heartbeat', async () => {
 socketRedisReady.mockReturnValue(false); startProcessHeartbeat(); await jest.advanceTimersByTimeAsync(1);
 expect(JSON.parse(fs.writeFile.mock.calls[0][1]).ready).toBe(false); expect(Heartbeat.updateOne).not.toHaveBeenCalled();
});
test('non-scale execution is unchanged; API heartbeat writes no worker file', async () => {
 delete process.env.SCALE_PROFILE; startProcessHeartbeat(); await jest.advanceTimersByTimeAsync(1); expect(Heartbeat.updateOne).not.toHaveBeenCalled();
 process.env.SCALE_PROFILE='business-1000-voice-350'; process.env.PROCESS_ROLE='api'; startProcessHeartbeat(); await jest.advanceTimersByTimeAsync(1);
 expect(Heartbeat.updateOne).toHaveBeenCalled(); expect(fs.writeFile).not.toHaveBeenCalled();
});
test('heartbeat persistence failure is caught and retried on the next tick', async () => {
 Heartbeat.updateOne.mockReturnValueOnce({ maxTimeMS: async () => { throw new Error('unavailable'); } });
 startProcessHeartbeat(); await jest.advanceTimersByTimeAsync(10001); expect(Heartbeat.updateOne).toHaveBeenCalledTimes(2);
});
