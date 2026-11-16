import Controller from '../../src/controllers/messageMedia.js';
import Db from '../../src/db/db.js';
import Message from '../../src/models/message.js';
import {loadProviderMedia} from '../../src/services/security/providerMedia.js';
jest.mock('../../src/db/db.js',()=>({getBusinessScopeByOwner:jest.fn()}));
jest.mock('../../src/models/message.js',()=>({findOne:jest.fn()}));
jest.mock('../../src/services/security/providerMedia.js',()=>({...jest.requireActual('../../src/services/security/providerMedia.js'),loadProviderMedia:jest.fn()}));
const id='123456789012345678901234';
function request(){return {user:{userId:'owner'},params:{messageId:id,mediaIndex:'0'}};}
function response(){const res={headers:{},destroyed:false};res.status=jest.fn(()=>res);res.json=jest.fn(()=>res);res.send=jest.fn(()=>res);res.setHeader=jest.fn((key,value)=>{res.headers[key]=value});return res;}
beforeEach(()=>{jest.clearAllMocks();process.env.TWILIO_ACCOUNT_SID='AC00000000000000000000000000000000';process.env.TWILIO_AUTH_TOKEN='synthetic-media-token';Db.getBusinessScopeByOwner.mockResolvedValue({_id:'business'});Message.findOne.mockResolvedValue({media:[{providerUrl:'https://api.twilio.com/media/one'}]});loadProviderMedia.mockResolvedValue({buffer:Buffer.from('image'),contentType:'image/png'});});
test('media query is tenant-scoped and passive previews have restrictive response headers',async()=>{
 const req=request(),res=response();await Controller.getMedia(req,res);
 expect(Message.findOne).toHaveBeenCalledWith({_id:id,business:'business'});expect(res.status).toHaveBeenCalledWith(200);expect(res.send).toHaveBeenCalledWith(Buffer.from('image'));
 expect(res.headers).toMatchObject({'Content-Type':'image/png','Content-Length':'5','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline; filename="callbackiq-media-0"'});
});
test('active upstream content is an inert attachment',async()=>{loadProviderMedia.mockResolvedValue({buffer:Buffer.from('<script>'),contentType:'text/html'});const res=response();await Controller.getMedia(request(),res);expect(res.headers['Content-Type']).toBe('application/octet-stream');expect(res.headers['Content-Disposition']).toMatch(/^attachment;/);});
test.each([401,400,404,503])('rejected media requests do not contact the provider: %s',async status=>{
 const req=request(),res=response();if(status===401)req.user=null;if(status===400)req.params.messageId='invalid';if(status===404)Message.findOne.mockResolvedValue(null);if(status===503)delete process.env.TWILIO_AUTH_TOKEN;
 await Controller.getMedia(req,res);expect(res.status).toHaveBeenCalledWith(status);expect(loadProviderMedia).not.toHaveBeenCalled();
});
test('invalid index and absent business fail before reading media',async()=>{const req=request(),res=response();req.params.mediaIndex='-1';await Controller.getMedia(req,res);expect(res.status).toHaveBeenCalledWith(400);Db.getBusinessScopeByOwner.mockResolvedValue(null);req.params.mediaIndex='0';await Controller.getMedia(req,res);expect(res.status).toHaveBeenLastCalledWith(404);});
test.each([413,429,undefined])('bounded upstream failure has a safe HTTP response: %s',async statusCode=>{
 loadProviderMedia.mockRejectedValue(Object.assign(new Error('synthetic upstream error'),{statusCode}));const res=response();await Controller.getMedia(request(),res);expect(res.status).toHaveBeenCalledWith(statusCode||502);if(statusCode===429)expect(res.headers['Retry-After']).toBe('2');expect(res.json).toHaveBeenCalledWith({success:false,message:'Unable to load message media.'});
});
test('a disconnected media client is not written to again',async()=>{loadProviderMedia.mockRejectedValue(new Error('disconnected'));const res=response();res.destroyed=true;await Controller.getMedia(request(),res);expect(res.json).not.toHaveBeenCalled();});
