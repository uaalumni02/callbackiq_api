import { validateVoiceTopology } from '../../src/config/voiceTopology.js';
const fixture = () => ({items: [
 {kind:'ConfigMap',metadata:{name:'callbackiq-scale'},data:{SCALE_TARGET_VOICE:'350',SCALE_VOICE_REPLICAS:'6',API_INSTANCE_COUNT:'4',VOICE_INSTANCE_MAX_SESSIONS:'100',VOICE_INSTANCE_MAX_AI_TURNS:'75',VOICE_FLEET_MAX_SESSIONS:'450',VOICE_FLEET_MAX_AI_TURNS:'400',PROVIDER_VOICE_SESSION_QUOTA:'450',PROVIDER_AI_CONCURRENT_QUOTA:'2000',SOCKET_REDIS_REQUIRED:'true',SCALE_CACHE_NAMESPACE:'offline',VOICE_DRAIN_TIMEOUT_MS:'610000'}},
 ...['voice','api'].map(role=>({kind:'Deployment',metadata:{name:`callbackiq-${role}`},spec:{replicas:role==='voice'?6:4,template:{spec:{terminationGracePeriodSeconds:660,containers:[{envFrom:[{configMapRef:{name:'callbackiq-scale'}},{secretRef:{name:'callbackiq-runtime'}}],env:[{name:'PROCESS_ROLE',value:role},{name:'VOICE_RELAY_ENABLED',value:String(role==='voice')}]}]}}}})),
 {kind:'Service',metadata:{name:'callbackiq-voice'},spec:{selector:{role:'voice'}}},
 {kind:'Ingress',metadata:{annotations:{'nginx.ingress.kubernetes.io/proxy-read-timeout':'660'}},spec:{rules:[{http:{paths:[{path:'/ws/voice',backend:{service:{name:'callbackiq-voice'}}}]}}]}}
]});
test('declared N-1 topology passes without claiming live verification',()=>expect(validateVoiceTopology(fixture())).toEqual({passed:true,errors:[],liveInfrastructureVerified:false}));
test.each([
 m=>{m.items[1].spec.replicas=4;},
 m=>{m.items[0].data.VOICE_FLEET_MAX_SESSIONS='1000';},
 m=>{m.items[0].data.SCALE_VOICE_REPLICAS='7';},
 m=>{m.items[1].spec.template.spec.terminationGracePeriodSeconds=30;},
 m=>{m.items[3].spec.sessionAffinity='ClientIP';},
 m=>{m.items[4].spec.rules[0].http.paths[0].backend.service.name='callbackiq-api';},
 m=>{m.items[1].spec.template.spec.containers[0].env.push({name:'VOICE_CAPACITY_REDIS_URL',value:'redis://elsewhere'});},
 m=>{m.items[0].data.SOCKET_REDIS_REQUIRED='false';}
])('unsafe or inconsistent topology is rejected',change=>{const m=fixture();change(m);expect(validateVoiceTopology(m).passed).toBe(false);});
test('absent topology fails closed',()=>expect(validateVoiceTopology({}).passed).toBe(false));
