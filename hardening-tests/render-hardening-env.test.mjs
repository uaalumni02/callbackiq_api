import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironment } from '../src/config/env.js';
const base=()=>({
 APP_ENV:'staging', NODE_ENV:'production', MONGODB_URI:'mongodb://127.0.0.1:27017/callbackiq_staging',
 JWT_SECRET:'a'.repeat(64), CLIENT_URL:'https://app.callbackiq.test',
 PUBLIC_API_URL:'https://api.callbackiq.test', ALLOWED_ORIGINS:'https://app.callbackiq.test',
 TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32), TWILIO_AUTH_TOKEN:'token-for-test-only',
 STRIPE_SECRET_KEY:'sk_test_dummy', STRIPE_WEBHOOK_SECRET:'whsec_dummy', OPENAI_API_KEY:'fake-openai-test-key',
 STAGING_DATABASE_ISOLATED:'true', INTEGRATION_ENCRYPTION_KEY:'configured-non-placeholder-key',
 CALLBACKIQ_API_BASE_URL:'https://api.callbackiq.test',
 VOICE_HTTP_PUBLIC_URL:'https://api.callbackiq.test', VOICE_WEBSOCKET_PUBLIC_URL:'wss://api.example.test/ws/voice',
});
test('valid staged HTTPS/WSS endpoints retain functionality',()=>{
 const result=validateEnvironment(base(),{throwOnError:false});
 assert.equal(result.valid,true,result.errors.join('; '));
});
test('rejects legacy localhost auxiliary API URLs',()=>{
 const result=validateEnvironment({...base(),CALLBACKIQ_API_BASE_URL:'http://127.0.0.1:3000'},{throwOnError:false});
 assert.equal(result.valid,false);assert.match(result.errors.join(' '),/CALLBACKIQ_API_BASE_URL/);
});
test('rejects insecure WebSocket URLs',()=>{
 const result=validateEnvironment({...base(),VOICE_WEBSOCKET_PUBLIC_URL:'ws://localhost:3000/ws/voice'},{throwOnError:false});
 assert.equal(result.valid,false);assert.match(result.errors.join(' '),/VOICE_WEBSOCKET_PUBLIC_URL/);
});
test('rejects placeholder integration encryption credentials',()=>{
 const result=validateEnvironment({...base(),INTEGRATION_ENCRYPTION_KEY:'replace-with-a-secure-encryption-key'},{throwOnError:false});
 assert.equal(result.valid,false);assert.match(result.errors.join(' '),/INTEGRATION_ENCRYPTION_KEY/);
});
test('warns rather than claims staging database isolation without attestation',()=>{
 const {STAGING_DATABASE_ISOLATED,...env}=base();
 const result=validateEnvironment(env,{throwOnError:false});
 assert.equal(result.valid,true);assert.ok(result.warnings.some(w=>/isolated MongoDB/.test(w)));
});
