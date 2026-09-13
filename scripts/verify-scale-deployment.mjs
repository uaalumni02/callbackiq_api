import 'dotenv/config';
import { getMongoUrl } from '../src/config/runtime-environment.js';
const env=process.env, errors=[], notes=[];
const positive=key=>Number(env[key])>0;
if(!getMongoUrl())errors.push('Set MONGO_URL.');
if(!env.REDIS_URL && !env.SOCKET_REDIS_URL)errors.push('Configure shared Redis.');
if(env.SOCKET_REDIS_REQUIRED!=='true')errors.push('Set SOCKET_REDIS_REQUIRED=true for the distributed fleet.');
if(!['true','false'].includes(env.COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED))errors.push('Explicitly choose COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED=true or false and test outage behavior.');
if(env.PROCESS_ROLE==='voice'){
 for(const key of ['VOICE_INSTANCE_MAX_SESSIONS','VOICE_INSTANCE_MAX_AI_TURNS','VOICE_FLEET_MAX_SESSIONS','VOICE_FLEET_MAX_AI_TURNS'])if(!positive(key))errors.push(`Set a measured ${key}.`);
 const drain=Number(env.VOICE_DRAIN_TIMEOUT_MS)||610000;
 if(Number(env.DEPLOY_TERMINATION_GRACE_MS)<drain+15000 || !positive('DEPLOY_TERMINATION_GRACE_MS'))errors.push('Record DEPLOY_TERMINATION_GRACE_MS from the hosting configuration; it must exceed voice drain plus cleanup. This variable does not configure your host.');
}
if(env.STAFF_NOTIFICATION_EMAIL_ENABLED!=='true')errors.push('Enable and acceptance-test staff email notifications before unattended use.');
else if(!env.GMAIL_ADDRESS || !env.GMAIL_PASSWORD)errors.push('Configure the existing Gmail mail transport.');
notes.push('This checks declared configuration only. It cannot certify provider quotas, actual hosting grace, delivery, database indexes, or capacity.');
console.log(JSON.stringify({configurationCheckPassed:errors.length===0,errors,notes},null,2));
if(errors.length)process.exitCode=1;
