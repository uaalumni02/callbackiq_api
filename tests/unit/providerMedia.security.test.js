import { EventEmitter } from 'node:events';
import { loadProviderMedia, allowedMediaUrl } from '../../src/services/security/providerMedia.js';
const options=()=>({url:'https://api.twilio.com/media',authorization:'synthetic-auth',businessId:'b1',req:new EventEmitter(),res:new EventEmitter()});
test('safe redirects never forward provider credentials to a CDN',async()=>{
 const fetcher=jest.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://media.twiliocdn.com/file'}})).mockResolvedValueOnce(new Response('image',{headers:{'content-type':'image/png'}}));
 const result=await loadProviderMedia({...options(),fetcher});expect(result.buffer.toString()).toBe('image');expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('synthetic-auth');expect(fetcher.mock.calls[1][1].headers).toEqual({});
});
test('redirect to an untrusted destination is rejected before a second request',async()=>{
 const fetcher=jest.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://example.com/file'}}));
 await expect(loadProviderMedia({...options(),fetcher})).rejects.toThrow('not allowed');expect(fetcher).toHaveBeenCalledTimes(1);
 expect(allowedMediaUrl('https://api.twilio.com@evil.com')).toBe(false);expect(allowedMediaUrl('https://api.twilio.com:8443/a')).toBe(false);
});
test('declared and streamed oversized responses are bounded',async()=>{
 const large=5*1024*1024+1;
 await expect(loadProviderMedia({...options(),fetcher:async()=>new Response('small',{headers:{'content-length':String(large)}})})).rejects.toMatchObject({statusCode:413});
 await expect(loadProviderMedia({...options(),fetcher:async()=>new Response(new Uint8Array(large))})).rejects.toMatchObject({statusCode:413});
});
test('deadline and disconnect abort pending work and release the tenant budget',async()=>{
 const slow=jest.fn((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
 await expect(loadProviderMedia({...options(),fetcher:slow,timeoutMs:5})).rejects.toThrow('aborted');
 const first=options(),second=options();const a=loadProviderMedia({...first,fetcher:slow}),b=loadProviderMedia({...second,fetcher:slow});
 await expect(loadProviderMedia({...options(),fetcher:slow})).rejects.toMatchObject({statusCode:429});
 first.req.emit('aborted');second.res.emit('close');await expect(a).rejects.toThrow('aborted');await expect(b).rejects.toThrow('aborted');
 expect((await loadProviderMedia({...options(),fetcher:async()=>new Response('ok')})).buffer.toString()).toBe('ok');
});
test('upstream errors and redirect loops do not hold download permits',async()=>{
 await expect(loadProviderMedia({...options(),fetcher:async()=>new Response('',{status:404})})).rejects.toMatchObject({statusCode:404});
 await expect(loadProviderMedia({...options(),fetcher:async()=>new Response(null,{status:302,headers:{location:'/loop'}})})).rejects.toThrow('Too many');
});


describe('downloaded content cannot become an active application-origin document', () => {
  test.each(['text/html', 'image/svg+xml', 'application/pdf', '', undefined])('active/unknown type %s is an inert attachment', async value => {
    const { mediaResponsePolicy } = await import('../../src/services/security/providerMedia.js');
    expect(mediaResponsePolicy(value)).toEqual({ contentType: 'application/octet-stream', disposition: 'attachment' });
  });
  test('recognized passive media retains inline preview', async () => {
    const { mediaResponsePolicy } = await import('../../src/services/security/providerMedia.js');
    expect(mediaResponsePolicy('IMAGE/PNG; charset=binary')).toEqual({ contentType: 'image/png', disposition: 'inline' });
  });
});
