import request from 'supertest';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import { stabilizationFixture } from '../setup/stabilizationFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

beforeAll(connectTestDB,60000);afterEach(clearTestDB);afterAll(closeTestDB);
test('new dental signup receives 400 and creates no account',async()=>{
 const response=await request(app).post('/api/auth/register').send({email:'trade@example.test',password:'LongFixturePassword123',businessName:'Legacy Dental',businessType:'dental',termsAccepted:true,privacyAccepted:true});
 expect(response.status).toBe(400);expect(await Business.countDocuments()).toBe(0);expect(await User.countDocuments()).toBe(0);
});
test('existing legacy business and user can save unrelated fields, but cannot change to another removed type',async()=>{
 const {business,user}=await stabilizationFixture();
 await Business.collection.updateOne({_id:business._id},{$set:{businessType:'dental'}});
 await User.collection.updateOne({_id:user._id},{$set:{businessType:'dental'}});
 const stored=await Business.findById(business._id);stored.businessName='Updated legacy business';await stored.save();
 const account=await User.findById(user._id);account.businessName='Updated legacy account';await account.save();
 expect((await Business.findById(business._id)).businessType).toBe('dental');
 stored.businessType='restaurant';await expect(stored.save()).rejects.toThrow(/business type/i);
 stored.businessType='hvac';await stored.save();expect((await Business.findById(business._id)).businessType).toBe('hvac');
 await expect(Business.create({owner:user._id,businessName:'New invalid',businessType:'dental'})).rejects.toThrow(/business type/i);
});
test('owner can keep an unchanged legacy type in a profile update, but cannot choose a removed type',async()=>{
 const {business,token}=await stabilizationFixture();await Business.collection.updateOne({_id:business._id},{$set:{businessType:'dental'}});
 const patch=body=>request(app).patch('/api/businesses/mine').set('Authorization',`Bearer ${token}`).send(body);
 expect((await patch({businessName:'Legacy update',businessType:'dental'})).status).toBe(200);
 expect((await patch({businessType:'restaurant'})).status).toBe(400);
 expect((await patch({businessType:'hvac'})).status).toBe(200);
});
