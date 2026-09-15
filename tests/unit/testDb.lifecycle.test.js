import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
jest.mock('mongoose',()=>({__esModule:true,default:{connect:jest.fn(),connection:{readyState:0,collections:{},dropDatabase:jest.fn(),close:jest.fn()}}}));
jest.mock('mongodb-memory-server',()=>({MongoMemoryServer:jest.fn()}));
let instance;
beforeEach(()=>{
 jest.clearAllMocks();mongoose.connection.readyState=0;mongoose.connection.collections={};
 mongoose.connect.mockResolvedValue();mongoose.connection.close.mockResolvedValue();mongoose.connection.dropDatabase.mockResolvedValue();
 instance={start:jest.fn().mockResolvedValue(),stop:jest.fn().mockResolvedValue(),getUri:jest.fn().mockReturnValue('mongodb://127.0.0.1:27017/isolated')};
 MongoMemoryServer.mockImplementation(()=>instance);
});
afterEach(async()=>{await closeTestDB();});
test('connects only to its owned ephemeral instance with bounded timeouts',async()=>{
 await connectTestDB();expect(MongoMemoryServer).toHaveBeenCalledWith({instance:{launchTimeout:30000}});
 expect(mongoose.connect).toHaveBeenCalledWith('mongodb://127.0.0.1:27017/isolated',{serverSelectionTimeoutMS:15000});
 mongoose.connection.readyState=1;const deleteMany=jest.fn().mockResolvedValue();mongoose.connection.collections={test:{deleteMany}};
 await clearTestDB();expect(deleteMany).toHaveBeenCalledWith({});await closeTestDB();
 expect(mongoose.connection.dropDatabase).toHaveBeenCalledTimes(1);expect(instance.stop).toHaveBeenCalledTimes(1);
});
test('startup failure remains a failure and cleanup does not query a disconnected DB',async()=>{
 const error=new Error('startup timeout');instance.start.mockRejectedValue(error);
 await expect(connectTestDB()).rejects.toBe(error);await clearTestDB();await closeTestDB();
 expect(mongoose.connect).not.toHaveBeenCalled();expect(mongoose.connection.dropDatabase).not.toHaveBeenCalled();expect(instance.stop).toHaveBeenCalledTimes(1);
});
test('connection failure closes partial connection and preserves original error even if stop fails',async()=>{
 const error=new Error('connect failed');mongoose.connection.readyState=2;mongoose.connect.mockRejectedValue(error);instance.stop.mockRejectedValue(new Error('stop failed'));
 await expect(connectTestDB()).rejects.toBe(error);expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
});
test('drop failure still closes and stops the owned server',async()=>{
 await connectTestDB();mongoose.connection.readyState=1;mongoose.connection.dropDatabase.mockRejectedValue(new Error('drop failed'));
 await expect(closeTestDB()).rejects.toThrow('drop failed');expect(mongoose.connection.close).toHaveBeenCalledTimes(1);expect(instance.stop).toHaveBeenCalledTimes(1);
});
test('repeated teardown does not drop an unrelated connection',async()=>{
 mongoose.connection.readyState=1;await closeTestDB();expect(mongoose.connection.dropDatabase).not.toHaveBeenCalled();expect(mongoose.connection.close).not.toHaveBeenCalled();
});
