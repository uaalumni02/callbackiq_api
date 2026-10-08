import VoiceSession from '../models/voiceSession.js';
import {createAwaitedKeyBatch} from '../services/database/awaitedKeyBatch.js';

// Realtime callers await persistence; they already keep their transcript locally.
// Return a small acknowledgement instead of rereading/hydrating every prior turn.
// The durable transcript is retained in full. An explicit returnSession request
// in VoiceTranscriptService.append retains the full-document lookup when needed.
const batch=createAwaitedKeyBatch({maxConcurrent:4,execute:async rows=>{
 if(rows.length===1){const r=rows[0];const result=await VoiceSession.updateOne({_id:r.sessionId},r.update);return [result.matchedCount?{_id:r.sessionId,lastActivityAt:r.update.$set.lastActivityAt}:null];}
 const written=await VoiceSession.bulkWrite(rows.map(r=>({updateOne:{filter:{_id:r.sessionId},update:r.update}})),{ordered:false});
 // A matching stored entry proves each individual append, including its date.
 // Aggregate write counts alone cannot establish which session was updated.
 const sessions=await VoiceSession.find({$or:rows.map(r=>({_id:r.sessionId,transcript:{$elemMatch:r.update.$push.transcript}}))}).select('_id lastActivityAt').lean();
 if(sessions.length!==written.matchedCount)throw new Error('Incomplete voice transcript persistence readback');
 const byId=new Map(sessions.map(s=>[String(s._id),s]));
 return rows.map(r=>byId.get(String(r.sessionId))||null);
}});
export function appendVoiceTranscriptUpdate(sessionId,update){
 if(!VoiceSession.schema||typeof VoiceSession.bulkWrite!=='function')return VoiceSession.findByIdAndUpdate(sessionId,update,{returnDocument:'after'});
 return batch.enqueue(String(sessionId),{sessionId,update});
}
