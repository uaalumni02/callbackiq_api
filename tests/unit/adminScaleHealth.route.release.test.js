import express from 'express';
import request from 'supertest';
import router from '../../src/routes/admin.routes.js';
import User from '../../src/models/user.js';
import { readScaleHealth } from '../../src/services/scaleHealth.service.js';
jest.mock('../../src/services/scaleHealth.service.js',()=>({readScaleHealth:jest.fn()}));
// Authentication boundary is doubled; the real admin middleware rechecks the database role.
jest.mock('../../src/middleware/check-auth.js',()=>({__esModule:true,default:(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.user={userId:'owner'};next();}}));
const app=express();app.use('/admin',router);app.use((error,req,res,next)=>res.status(503).json({message:'Health unavailable'}));
beforeEach(()=>{jest.spyOn(User,'findById').mockReturnValue({select:()=>({lean:async()=>({role:'admin'})})});readScaleHealth.mockReset();});
afterEach(()=>jest.restoreAllMocks());
test('admin receives an uncached snapshot',async()=>{readScaleHealth.mockResolvedValue({healthy:true});const r=await request(app).get('/admin/scale-health').set('Authorization','test');expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.body.data).toEqual({healthy:true});});
test('health failures reach error middleware',async()=>{readScaleHealth.mockRejectedValue(new Error('Mongo unavailable'));const r=await request(app).get('/admin/scale-health').set('Authorization','test');expect(r.status).toBe(503);});
test('anonymous and nonadmin callers cannot read the fleet snapshot',async()=>{expect((await request(app).get('/admin/scale-health')).status).toBe(401);User.findById.mockReturnValue({select:()=>({lean:async()=>({role:'owner'})})});expect((await request(app).get('/admin/scale-health').set('Authorization','test')).status).toBe(403);expect(readScaleHealth).not.toHaveBeenCalled();});
