import Usage from '../../src/models/communicationUsage.js';
import mongoose from 'mongoose';
import {releaseCommunicationUsage} from '../../src/services/communicationUsage.service.js';
afterEach(()=>jest.restoreAllMocks());
test('release passes the pipeline through real Mongoose validation to the driver',async()=>{
 const write=jest.spyOn(Usage.collection,'updateOne').mockResolvedValue({acknowledged:true,modifiedCount:1});
 await releaseCommunicationUsage({reservations:[{_id:new mongoose.Types.ObjectId()}],amount:2});
 expect(write).toHaveBeenCalledTimes(1);
 expect(write.mock.calls[0][1][0].$set.count.$max[1].$subtract[1]).toBe(2);
});
test('release preserves the provided transaction session through Mongoose',async()=>{
 const write=jest.spyOn(Usage.collection,'updateOne').mockResolvedValue({acknowledged:true,modifiedCount:1});
 const session={id:'test-transaction'};
 await releaseCommunicationUsage({reservations:[{_id:new mongoose.Types.ObjectId()}],mongoSession:session});
 expect(write.mock.calls[0][2].session).toEqual(session);
});
