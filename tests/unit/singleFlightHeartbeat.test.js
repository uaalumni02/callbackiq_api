import {EventEmitter} from 'node:events';
import {startSingleFlightHeartbeat} from '../../src/services/webhooks/singleFlightHeartbeat.js';
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
beforeEach(()=>jest.useFakeTimers());afterEach(()=>{jest.clearAllTimers();jest.useRealTimers();});
test('slow renewal cannot accumulate concurrent database writes',async()=>{
 const res=new EventEmitter();let release;const renew=jest.fn(()=>new Promise(resolve=>{release=resolve;}));
 startSingleFlightHeartbeat({res,intervalMs:1000,renew,onError:jest.fn()});
 jest.advanceTimersByTime(6000);expect(renew).toHaveBeenCalledTimes(1);
 release();await flush();jest.advanceTimersByTime(1000);expect(renew).toHaveBeenCalledTimes(2);
 res.emit('finish');release();await flush();jest.advanceTimersByTime(10000);expect(renew).toHaveBeenCalledTimes(2);
 expect(res.listenerCount('close')).toBe(0);
});
test('renewal failure is reported and next interval can retry',async()=>{
 const res=new EventEmitter(),error=new Error('database slow'),onError=jest.fn();
 const renew=jest.fn().mockRejectedValueOnce(error).mockResolvedValue({});
 startSingleFlightHeartbeat({res,intervalMs:1000,renew,onError});jest.advanceTimersByTime(1000);await flush();expect(onError).toHaveBeenCalledWith(error);
 jest.advanceTimersByTime(1000);await flush();expect(renew).toHaveBeenCalledTimes(2);res.emit('close');jest.advanceTimersByTime(3000);expect(renew).toHaveBeenCalledTimes(2);
});
test('disconnect before first renewal stops the timer',()=>{
 const res=new EventEmitter(),renew=jest.fn();startSingleFlightHeartbeat({res,intervalMs:1000,renew,onError:jest.fn()});res.emit('close');jest.advanceTimersByTime(3000);expect(renew).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
