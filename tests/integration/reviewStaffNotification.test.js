import mongoose from 'mongoose';
import {connectTestDB, clearTestDB, closeTestDB} from '../setup/testDb.js';
import Alert from '../../src/models/alert.js';
import Job from '../../src/models/staffNotificationJob.js';
import {enqueueStaffNotifications} from '../../src/services/staffNotification.service.js';
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertUpdated:jest.fn()}}));
beforeAll(async()=>{await connectTestDB();await Promise.all([Alert.init(),Job.init()]);},120000);
afterEach(async()=>{await clearTestDB();delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;});
afterAll(closeTestDB);
test.each(['medium','high'])('staff review notification eligibility: %s',async priority=>{
 process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';
 const now=new Date();
 const alert=await Alert.create({business:new mongoose.Types.ObjectId(),type:'system',title:'Service eligibility needs review',message:'Please review',priority,actionRequired:true,dueAt:new Date(now.getTime()-60000),metadata:{serviceEligibilityReason:'unrecognized_service'}});
 await enqueueStaffNotifications({now});
 const jobs=await Job.countDocuments({alert:alert._id});
 console.log('STAFF_PROBE',JSON.stringify({priority,jobs}));
 expect(jobs).toBeGreaterThan(0);
});

test.each(['initial','overdue','acknowledged','resolved'])('service review lifecycle: %s',async stage=>{
 process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';const now=new Date();
 const alert=await Alert.create({business:new mongoose.Types.ObjectId(),type:'system',title:'Review',message:'Review service',priority:'medium',actionRequired:true,dueAt:new Date(now.getTime()+(stage==='initial'?60000:-60000)),metadata:{serviceEligibilityReason:'unrecognized_service'},...(stage==='acknowledged'?{acknowledgedAt:now}:{}),...(stage==='resolved'?{resolvedAt:now}:{})});
 await enqueueStaffNotifications({now});await enqueueStaffNotifications({now});
 const jobs=await Job.find({alert:alert._id});
 expect(jobs).toHaveLength(['initial','overdue'].includes(stage)?1:0);
 if(jobs.length)expect(jobs[0].stage).toBe(stage);
});
