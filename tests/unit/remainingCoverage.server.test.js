// Server orchestration runs with socket, provider and worker boundaries mocked.
jest.mock('../../src/services/processHeartbeat.service.js', () => ({ startProcessHeartbeat: jest.fn(), stopProcessHeartbeat: jest.fn() }));
jest.mock("../../src/workers/adminReporting.worker.js",()=>({__esModule:true,startAdminReportingWorker: jest.fn(),stopAdminReportingWorker: jest.fn()}));
jest.mock("../../src/helpers/logging/safeLogger.js",()=>({__esModule:true,safeConsole: jest.fn()}));
jest.mock("../../src/workers/webhookWork.worker.js",()=>({__esModule:true,startWebhookWorkWorker: jest.fn(),stopWebhookWorkWorker: jest.fn()}));
jest.mock("../../src/services/runtimeState.service.js",()=>({__esModule:true,beginDrain: jest.fn()}));
jest.mock("../../src/services/socketSession.service.js",()=>({__esModule:true,enforceSocketExpiry: jest.fn(),startSocketSessionMaintenance: jest.fn()}));
jest.mock("../../src/workers/smsDeliveryReconciliation.worker.js",()=>({__esModule:true,startSmsDeliveryReconciliationWorker: jest.fn(),stopSmsDeliveryReconciliationWorker: jest.fn()}));
jest.mock("../../src/workers/smsIngressReconciliation.worker.js",()=>({__esModule:true,startSmsIngressReconciliationWorker: jest.fn(),stopSmsIngressReconciliationWorker: jest.fn()}));
jest.mock("../../src/config/twilio-production-config.js",()=>({__esModule:true,assertTwilioProductionConfig: jest.fn()}));
jest.mock("../../src/workers/conversationLifecycle.worker.js",()=>({__esModule:true,startConversationLifecycleWorker: jest.fn(),stopConversationLifecycleWorker: jest.fn()}));
jest.mock("../../src/workers/smsProcessing.worker.js",()=>({__esModule:true,startSmsProcessingWorker: jest.fn(),stopSmsProcessingWorker: jest.fn()}));
jest.mock("../../src/workers/voiceUsageReconciliation.worker.js",()=>({__esModule:true,startVoiceUsageReconciliationWorker: jest.fn(),stopVoiceUsageReconciliationWorker: jest.fn()}));
jest.mock("../../src/app.js",()=>({__esModule:true,default: jest.fn()}));
jest.mock("../../src/db/connection.js",()=>({__esModule:true,default: jest.fn()}));
jest.mock("../../src/middleware/socket-auth.js",()=>({__esModule:true,default: jest.fn()}));
jest.mock("../../src/services/socket.service.js",()=>({__esModule:true,default: jest.fn()}));
jest.mock("../../src/services/socketRedisAdapter.service.js",()=>({__esModule:true,closeSocketRedisAdapter: jest.fn(),initializeSocketRedisAdapter: jest.fn()}));
jest.mock("../../src/config/cors.js",()=>({__esModule:true,socketCorsOptions: jest.fn()}));
jest.mock("../../src/workers/automation.worker.js",()=>({__esModule:true,startAutomationWorker: jest.fn(),stopAutomationWorker: jest.fn()}));
jest.mock("../../src/workers/appointmentMaintenance.worker.js",()=>({__esModule:true,startAppointmentMaintenanceWorker: jest.fn(),stopAppointmentMaintenanceWorker: jest.fn()}));
jest.mock("../../src/voice/conversationRelay.server.js",()=>({__esModule:true,initializeConversationRelayServer: jest.fn()}));
jest.mock("../../src/config/env.js",()=>({__esModule:true,validateEnvironment: jest.fn()}));
jest.mock("../../src/services/runtimeMetrics.service.js",()=>({__esModule:true,startRuntimeMetricsLogging: jest.fn()}));
jest.mock("../../src/services/scaleCache.service.js",()=>({__esModule:true,closeScaleCache: jest.fn()}));
jest.mock("../../src/config/runtime-environment.js",()=>({__esModule:true,assertRealtimeScalingConfig: jest.fn(),assertServerProcessRole: jest.fn(),normalizeRuntimeEnvironment: jest.fn(),shouldRunEmbeddedWorkers: jest.fn()}));
jest.mock("../../src/workers/a2pReconciliation.worker.js",()=>({__esModule:true,startA2pReconciliationWorker: jest.fn(),stopA2pReconciliationWorker: jest.fn()}));
jest.mock("../../src/workers/trialLifecycle.worker.js",()=>({__esModule:true,startTrialLifecycleWorker: jest.fn(),stopTrialLifecycleWorker: jest.fn()}));

jest.mock('dotenv/config',()=>({}));
jest.mock('mongoose',()=>({__esModule:true,default:{connection:{readyState:0,close:jest.fn()}}}));
jest.mock('http',()=>({createServer:jest.fn()}));
jest.mock('socket.io',()=>({Server:jest.fn()}));
test('SIGTERM waits for lifecycle shutdown before closing voice and exiting',async()=>{
 const http={listen:jest.fn((port,callback)=>callback()),on:jest.fn(),listening:false};require('http').createServer.mockReturnValue(http);
 const io={use:jest.fn(),on:jest.fn(),close:jest.fn(cb=>cb())};require('socket.io').Server.mockImplementation(()=>io);
 require('../../src/services/socket.service.js').default.initialize=jest.fn();
 require('../../src/helpers/logging/safeLogger.js').safeConsole={log:jest.fn(),error:jest.fn()};
 require('../../src/services/socketSession.service.js').startSocketSessionMaintenance.mockReturnValue(jest.fn());
 const relay={close:jest.fn().mockResolvedValue(),beginDrain:jest.fn()};require('../../src/voice/conversationRelay.server.js').initializeConversationRelayServer.mockReturnValue(relay);
 let release;const lifecycle=require('../../src/workers/conversationLifecycle.worker.js');lifecycle.stopConversationLifecycleWorker.mockImplementation(()=>new Promise(r=>{release=r;}));
 const handlers={};const on=jest.spyOn(process,'on').mockImplementation((event,fn)=>{handlers[event]=fn;return process;});
 const exit=jest.spyOn(process,'exit').mockImplementation(()=>{});const prior=process.env.VOICE_RELAY_ENABLED;process.env.VOICE_RELAY_ENABLED='true';
 try {
  require('../../src/server.js');await new Promise(r=>setImmediate(r));
  expect(require('../../src/services/processHeartbeat.service.js').startProcessHeartbeat).toHaveBeenCalledTimes(1);
  handlers.SIGTERM();await new Promise(r=>setImmediate(r));
  expect(lifecycle.stopConversationLifecycleWorker).toHaveBeenCalledTimes(1);expect(relay.close).not.toHaveBeenCalled();expect(exit).not.toHaveBeenCalled();
  release();await new Promise(r=>setImmediate(r));expect(relay.close).toHaveBeenCalledTimes(1);expect(exit).toHaveBeenCalledWith(0);
 } finally {if(release)release();await new Promise(r=>setImmediate(r));on.mockRestore();exit.mockRestore();if(prior===undefined)delete process.env.VOICE_RELAY_ENABLED;else process.env.VOICE_RELAY_ENABLED=prior;}
});
