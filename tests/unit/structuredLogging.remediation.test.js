import logger from '../../src/config/logger.js';
import requestContext from '../../src/middleware/request-context.js';
import { safeConsole } from '../../src/helpers/logging/safeLogger.js';
afterEach(()=>jest.restoreAllMocks());
test('production HTTP records retain correlation and operational fields after redaction',()=>{
 const original=process.env.NODE_ENV;process.env.NODE_ENV='production';
 const output=jest.spyOn(console,'log').mockImplementation(()=>{});
 try {
  logger.info('http_request_completed',{requestId:'request-123456789012',businessId:'507f1f77bcf86cd799439011',
   statusCode:200,durationMs:12.5,token:'synthetic-secret',body:'Customer private text',error:new Error('private text')});
  const record=JSON.parse(output.mock.calls[0][0]);
  expect(record).toMatchObject({event:'http_request_completed',requestId:'request-123456789012',
   businessId:'507f1f77bcf86cd799439011',statusCode:200,durationMs:12.5,token:'[REDACTED]',body:'[REDACTED]'});
  expect(record.error.message).toBe('[REDACTED]');expect(JSON.stringify(record)).not.toContain('private text');
 } finally {process.env.NODE_ENV=original;}
});
test('the structured logger does not feed a serialized record to the scalar console wrapper',()=>{
 const wrapper=jest.spyOn(safeConsole,'log').mockImplementation(()=>{});jest.spyOn(console,'log').mockImplementation(()=>{});
 logger.info('stable_event',{requestId:'request'});expect(wrapper).not.toHaveBeenCalled();
});
test('request logging uses the route template and never the OAuth query',()=>{
 let finish;const req={headers:{'x-request-id':'trace-fixture'},method:'GET',baseUrl:'/api/integrations',
  path:'/oauth/synthetic-person@example.com',originalUrl:'/oauth?code=synthetic-secret',route:{path:'/oauth/:id'}};
 const res={statusCode:200,setHeader:jest.fn(),on:(_name,callback)=>{finish=callback;}};
 const info=jest.spyOn(console,'log').mockImplementation(()=>{});
 requestContext(req,res,jest.fn());finish();expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({event:'http_request_completed',requestId:'trace-fixture',path:'/api/integrations/oauth/:id'});
});
