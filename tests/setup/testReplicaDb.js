import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
let replica;
export async function connectTestDB() {
 replica=new MongoMemoryReplSet({replSet:{count:1,storageEngine:'wiredTiger'}});
 try {await replica.start();await mongoose.connect(replica.getUri());
  // Finish DDL before transaction tests; background index creation can block a transaction.
  await Promise.all(Object.values(mongoose.models).map(model=>model.init()));}
 catch(error){try{await mongoose.disconnect()}finally{await replica.stop()}throw error;}
}
export {clearTestDB} from './testDb.js';
export async function closeTestDB(){try{await mongoose.disconnect()}finally{await replica?.stop();replica=undefined}}
