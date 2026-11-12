import twilio from 'twilio';
import {removeProviderNumber,inspectProviderNumber} from '../../src/integrations/phoneNumberOperations.js';
const account='AC00000000000000000000000000000000';
function sdk(response){
 const request=jest.fn(async()=>{if(response instanceof Error)throw response;return response});
 return {client:twilio(account,'synthetic-contract-token',{httpClient:{request}}),request};
}
test('real Twilio SDK deletion produces a verified receipt only after a successful HTTP response',async()=>{
 const {client,request}=sdk({statusCode:204,body:'',headers:{}});
 expect(await removeProviderNumber(client,'PN123')).toEqual({outcome:'absent',evidence:'removed'});
 expect(request).toHaveBeenCalledWith(expect.objectContaining({method:'delete',uri:expect.stringContaining(`/Accounts/${account}/IncomingPhoneNumbers/PN123.json`)}));
});
test.each([[404,'absent'],[403,'rejected'],[408,'uncertain'],[503,'uncertain']])('maps HTTP %s from the actual SDK to %s',async(statusCode,outcome)=>{
 const {client}=sdk({statusCode,headers:{},body:JSON.stringify({code:20404,message:'Synthetic provider response'})});
 expect(await removeProviderNumber(client,'PN123')).toMatchObject({outcome});
});
test('a lost transport receipt is uncertain',async()=>{
 const {client}=sdk(Object.assign(new Error('Synthetic connection lost'),{code:'ETIMEDOUT'}));
 expect(await removeProviderNumber(client,'PN123')).toEqual({outcome:'uncertain',errorCode:'ETIMEDOUT'});
});
test.each([['PN123','present'],['PN_OTHER','uncertain']])('requires an exact SID in lookup response %s',async(sid,outcome)=>{
 const {client}=sdk({statusCode:200,headers:{},body:JSON.stringify({sid})});
 expect(await inspectProviderNumber(client,'PN123')).toMatchObject({outcome});
});
test('404 on the actual SDK lookup is evidence of absence',async()=>{
 const {client}=sdk({statusCode:404,headers:{},body:JSON.stringify({code:20404,message:'Synthetic missing resource'})});
 expect(await inspectProviderNumber(client,'PN123')).toEqual({outcome:'absent',evidence:'lookup_absent'});
});
