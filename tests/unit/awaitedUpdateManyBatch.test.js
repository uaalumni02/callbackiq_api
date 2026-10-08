import mongoose from 'mongoose';
import CallLog from '../../src/models/callLog.js';
import AutomationJob from '../../src/models/automationJob.js';
import {awaitedUpdateManyBatch} from '../../src/services/database/awaitedUpdateManyBatch.js';
const id=()=>new mongoose.Types.ObjectId();
afterEach(()=>jest.restoreAllMocks());
test('two pending writes share a command, retain individual predicates and await completion',async()=>{
 let finish;const Model={updateMany:jest.fn(),bulkWrite:jest.fn(()=>new Promise(resolve=>finish=resolve))};
 const write=awaitedUpdateManyBatch(Model,'testWrites'), operations=[1,2].map(i=>({filter:{business:`b${i}`,conversation:`c${i}`,status:{$in:['scheduled','processing']}},update:{$set:{status:'canceled'}}}));
 let completed=0;const promises=operations.map(op=>write(op).then(()=>completed++));
 await new Promise(resolve=>setImmediate(resolve));await Promise.resolve();
 expect(completed).toBe(0);expect(Model.bulkWrite).toHaveBeenCalledWith(operations.map(updateMany=>({updateMany})),{ordered:false});
 finish({acknowledged:true});await Promise.all(promises);expect(completed).toBe(2);expect(Model.updateMany).not.toHaveBeenCalled();
});
test('partial/unknown bulk failure rejects every waiting caller for idempotent retry',async()=>{
 const error=new Error('write failed');const Model={bulkWrite:jest.fn().mockRejectedValue(error)};
 const write=awaitedUpdateManyBatch(Model,'testErrors');
 const results=await Promise.allSettled([write({filter:{business:'a'},update:{$set:{}}}),write({filter:{business:'b'},update:{$set:{}}})]);
 expect(results.map(r=>r.reason)).toEqual([error,error]);
});
test('single low-traffic write keeps ordinary updateMany behavior',async()=>{
 const result={modifiedCount:2};const Model={updateMany:jest.fn().mockResolvedValue(result),bulkWrite:jest.fn()};
 const operation={filter:{business:'a'},update:{$set:{status:'canceled'}}};
 expect(await awaitedUpdateManyBatch(Model,'testSingle')(operation)).toBe(result);expect(Model.bulkWrite).not.toHaveBeenCalled();
});
test.each([CallLog,AutomationJob])('%p native bulk casting preserves IDs, update predicates and timestamps',async Model=>{
 const spy=jest.spyOn(Model.collection,'bulkWrite').mockResolvedValue({acknowledged:true});
 const write=awaitedUpdateManyBatch(Model,'native'+Model.modelName),ids=[id(),id()];
 await Promise.all(ids.map(business=>write({filter:{business:String(business),status:{$in:['scheduled','processing']}},update:{$set:Model===CallLog?{lead:String(id()),conversation:String(id())}:{status:'canceled',canceledAt:new Date(),lockedAt:null,lockedBy:null}}})));
 const [ops]=spy.mock.calls[0];expect(ops).toHaveLength(2);ops.forEach((op,i)=>{
  expect(op.updateMany.filter.business).toEqual(ids[i]);expect(op.updateMany.filter.status).toEqual({$in:['scheduled','processing']});
  expect(op.updateMany.update.$set.updatedAt).toBeInstanceOf(Date);
 });
});
