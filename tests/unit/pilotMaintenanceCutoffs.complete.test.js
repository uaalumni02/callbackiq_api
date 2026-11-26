import Sessions from '../../src/models/voiceSession.js';
import VoiceMaintenance from '../../src/voice/voiceSessionMaintenance.service.js';
import VoiceSessions from '../../src/voice/voiceSession.service.js';
jest.mock('../../src/models/voiceSession.js',()=>({__esModule:true,default:{find:jest.fn(),findOneAndUpdate:jest.fn(),updateMany:jest.fn()}}));
jest.mock('../../src/voice/voiceSession.service.js',()=>({__esModule:true,TERMINAL_STATUSES:new Set(['completed','failed','canceled']),default:{sendFallbackSms:jest.fn()}}));
jest.mock('../../src/helpers/logging/safeLogger.js',()=>({logOperationalError:jest.fn(),logOperationalWarning:jest.fn()}));
jest.mock('../../src/config/numericSettings.js',()=>({numericSetting:name=>require('../../config/numeric-settings.json')[name].default}));
let chain;
const now=new Date('2026-11-26T12:00:00Z');
beforeEach(()=>{jest.resetAllMocks();chain={sort:jest.fn().mockReturnThis(),limit:jest.fn().mockReturnThis(),select:jest.fn().mockReturnThis(),lean:jest.fn().mockResolvedValue([]),then:(resolve,reject)=>Promise.resolve([]).then(resolve,reject)};Sessions.find.mockReturnValue(chain);});
test.each([undefined,{}, {staleMinutes:3,limit:99999,now}])('M06 stale-session cleanup uses a bounded explicit or central cutoff: %p',async options=>{
 await expect(VoiceMaintenance.reapStaleSessions(options)).resolves.toMatchObject({scanned:0,errors:0});
 const filter=Sessions.find.mock.calls[0][0];expect(filter.status.$nin).toEqual(expect.arrayContaining(['completed','failed','canceled']));
 if(options?.now)expect(filter.lastActivityAt.$lt).toEqual(new Date(now.getTime()-3*60000));
 expect(chain.limit).toHaveBeenCalledWith(options?.limit?1000:100);
});
test('M06 redaction erases only the selected expired records and preserves a bounded batch',async()=>{
 chain.lean.mockResolvedValue([{_id:'old-session'}]);Sessions.updateMany.mockResolvedValue({matchedCount:1,modifiedCount:1});
 await expect(VoiceMaintenance.redactExpiredTranscripts({retentionDays:7,limit:9000,now})).resolves.toEqual({retentionDays:7,matched:1,modified:1});
 expect(Sessions.find.mock.calls[0][0].endedAt.$lt).toEqual(new Date(now.getTime()-7*86400000));expect(chain.limit).toHaveBeenCalledWith(5000);
 expect(Sessions.updateMany).toHaveBeenCalledWith({_id:{$in:['old-session']}},{$set:{transcript:[],summary:'','metadata.transcriptRedactedAt':now.toISOString(),'metadata.transcriptRetentionDays':7}});
});
test('M06 a failed stale session is counted without aborting later work',async()=>{
 chain.then=(resolve,reject)=>Promise.resolve([{_id:'stale',status:'active',fallbackSmsStatus:'failed'}]).then(resolve,reject);
 VoiceSessions.sendFallbackSms.mockRejectedValue(new Error('synthetic outage'));
 await expect(VoiceMaintenance.reapStaleSessions({now})).resolves.toMatchObject({scanned:1,fallbackAttempted:1,errors:1});
 expect(Sessions.findOneAndUpdate).not.toHaveBeenCalled();
});
