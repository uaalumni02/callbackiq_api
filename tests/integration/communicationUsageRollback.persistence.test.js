import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import Usage from '../../src/models/communicationUsage.js';
import Reservation from '../../src/models/communicationUsageReservation.js';
import {releaseCommunicationUsage} from '../../src/services/communicationUsage.service.js';
import {releaseCommunicationUsageReservation} from '../../src/services/communicationUsageReservation.service.js';
let mongo;
beforeAll(async()=>{mongo=await MongoMemoryReplSet.create({binary:{version:'7.0.24'},replSet:{count:1}});await mongoose.connect(mongo.getUri());await Promise.all([Usage.init(),Reservation.init()]);},120000);
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();});
const counter=async(count)=>Usage.create({business:new mongoose.Types.ObjectId(),scope:'business',scopeKey:'rollback-test',metric:'sms_outbound',window:'hour',windowStart:new Date(),count,expiresAt:new Date(Date.now()+86400000)});
test('actual MongoDB rollback decrements and clamps at zero',async()=>{
 const row=await counter(2);await releaseCommunicationUsage({reservations:[row],amount:1});expect((await Usage.findById(row._id)).count).toBe(1);
 await releaseCommunicationUsage({reservations:[row],amount:9});expect((await Usage.findById(row._id)).count).toBe(0);
});
test('expired releasing reservation recovers transactionally exactly once',async()=>{
 const row=await counter(3);
 const reservation=await Reservation.create({business:row.business,operationKey:'rollback-recovery',metric:'sms_outbound',amount:1,counterIds:[row._id],state:'releasing',ownerToken:'old-worker',releaseReason:'ATTR_TEST_SCOPE_REJECTED',leaseExpiresAt:new Date(Date.now()-1000),purgeAt:new Date(Date.now()+86400000)});
 await releaseCommunicationUsageReservation({reservation,reason:'ATTR_TEST_SCOPE_REJECTED'});
 expect((await Reservation.findById(reservation._id)).state).toBe('released');expect((await Usage.findById(row._id)).count).toBe(2);
 await releaseCommunicationUsageReservation({reservation,reason:'ATTR_TEST_SCOPE_REJECTED'});
 expect((await Usage.findById(row._id)).count).toBe(2);
});
