import express from 'express';
import request from 'supertest';
import authRoutes from '../../src/routes/auth.routes.js';
import resetRoutes from '../../src/routes/passwordReset.routes.js';
import AuthController from '../../src/controllers/auth.js';
const mockCounts = new Map();
jest.mock('../../src/models/requestRateLimitBucket.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn(({_id})=>({lean:async()=>{const count=(mockCounts.get(_id)||0)+1;mockCounts.set(_id,count);return {count};}}))}}));
jest.mock('../../src/controllers/auth.js',()=>({__esModule:true,default:Object.fromEntries(['register','login','me','logout','requestPasswordReset','resetPassword'].map(name=>[name,jest.fn((req,res)=>res.status(200).json({success:true}))]))}));
jest.mock('../../src/controllers/verification.js',()=>({__esModule:true,default:{status:jest.fn(),resendEmail:jest.fn(),verifyEmail:jest.fn()}}));
let app;
beforeEach(()=>{mockCounts.clear();jest.clearAllMocks();process.env.DISTRIBUTED_AUTH_RATE_LIMIT_ENABLED='true';process.env.TEST_AUTH_PUBLIC_RATE_LIMITS='true';app=express();app.use(express.json());app.use('/api/auth',authRoutes);app.use('/api/password-reset',resetRoutes);});
afterEach(()=>{delete process.env.DISTRIBUTED_AUTH_RATE_LIMIT_ENABLED;delete process.env.TEST_AUTH_PUBLIC_RATE_LIMITS;});
test('legacy and canonical request routes share one distributed five-request budget',async()=>{
 for(const path of ['/api/password-reset','/api/auth/request-password-reset','/api/password-reset','/api/auth/request-password-reset','/api/password-reset']) expect((await request(app).post(path).send({email:'test@example.invalid'})).status).toBe(200);
 expect((await request(app).post('/api/auth/request-password-reset').send({email:'test@example.invalid'})).status).toBe(429);
 expect((await request(app).post('/api/password-reset').send({email:'test@example.invalid'})).status).toBe(429);
 expect(AuthController.requestPasswordReset).toHaveBeenCalledTimes(5);
});
test('legacy and canonical token submission routes share the ten-request budget',async()=>{
 for(let i=0;i<10;i++) expect((await request(app).post(i%2?'/api/password-reset/token':'/api/auth/reset-password/token').send({password:'unused'})).status).toBe(200);
 expect((await request(app).post('/api/password-reset/token').send({password:'unused'})).status).toBe(429);
 expect((await request(app).post('/api/auth/reset-password/token').send({password:'unused'})).status).toBe(429);
 expect(AuthController.resetPassword).toHaveBeenCalledTimes(10);
});
