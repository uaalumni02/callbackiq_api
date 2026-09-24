import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { toSpokenReply } from '../../src/voice/voiceInput.service.js';
const subjects=[['kitchen sink','bathroom sink'],['furnace','air conditioner'],['front door lock','back door lock'],['garage door','garage door opener'],['roof','gutter'],['garage door opener','garage door']];
const phrases=[(a,b)=>`Actually, the ${b}, not the ${a}`,(a,b)=>`It's the ${b}, not the ${a}`,(a,b)=>`Not the ${a}, but the ${b}`,(a,b)=>`${b}, not ${a}`];
test.each(subjects.flatMap(([old,next])=>phrases.map(phrase=>({old,next,text:phrase(old,next)}))))('repeated interpretation preserves action and accepted subject: $text',({old,next,text})=>{
 const lead={serviceNeeded:`${old} needs replacement`};
 for(let i=0;i<5;i++) {lead.serviceNeeded=extractService(text,{lead});expect(lead.serviceNeeded).toBe(`${next} needs replacement`);}
});
test.each([
 ['10:00 AM','10 a.m.'],['10:30 PM','10:30 p.m.'],['12:00 AM','12 a.m.'],['12:00 PM','12 p.m.'],['00:00','12 a.m.'],['14:30','2:30 p.m.'],['23:59','11:59 p.m.'],['1:15 p.m.','1:15 p.m.'],['09:00 am','9 a.m.'],
])('spoken time remains stable across repeated presentation: %s',(input,expected)=>{
 let text=`Available at ${input}.`;
 for(let i=0;i<4;i++){text=toSpokenReply(text);expect(text).toContain(expected);expect(text).not.toMatch(/[ap]\.m\.\s*[AP]M|\.{2}/);}
});
test('speech preserves non-time numbers and emergency digit normalization',()=>{
 const result=toSpokenReply('Call 911. Estimate $199. Address 970 Main St, ZIP 30324.');
 expect(result).toContain('nine one one');expect(result).toContain('$199');expect(result).toContain('970 Main St');expect(toSpokenReply(result)).toBe(result);
});
