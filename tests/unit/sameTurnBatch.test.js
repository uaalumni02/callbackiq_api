import { sameTurnBatch } from '../../src/services/database/sameTurnBatch.js';

test('concurrent calls share commands, preserve caller order, and never cache', async () => {
 const execute=jest.fn(async values=>values.map(value=>value*2));
 const read=sameTurnBatch(execute,{maximum:3});
 expect(await Promise.all([1,2,3,4,5].map(read))).toEqual([2,4,6,8,10]);
 expect(execute.mock.calls.map(([values])=>values)).toEqual([[1,2,3],[4,5]]);
 expect(await read(1)).toBe(2);expect(execute).toHaveBeenCalledTimes(3);
});
test('batch failure rejects all waiters and later work recovers',async()=>{
 const error=new Error('database unavailable');
 const execute=jest.fn().mockRejectedValueOnce(error).mockImplementation(async values=>values);
 const read=sameTurnBatch(execute);
 const results=await Promise.allSettled([read('a'),read('b')]);
 expect(results.every(result=>result.status==='rejected'&&result.reason===error)).toBe(true);
 expect(await read('c')).toBe('c');
});
test('invalid result count fails closed and does not deliver another caller data',async()=>{
 const read=sameTurnBatch(async()=>['wrong']);
 const results=await Promise.allSettled([read('a'),read('b')]);
 expect(results.every(result=>result.status==='rejected')).toBe(true);
});
