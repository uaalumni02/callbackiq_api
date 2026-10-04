import mongoose from 'mongoose';
import { sanitizeLogDetails } from '../../src/helpers/logging/safeLogger.js';
import { redactLogValue } from '../../src/config/logger.js';
import Monitoring from '../../src/services/monitoring.service.js';
import errorHandler from '../../src/middleware/error-handler.js';
jest.mock('../../src/services/monitoring.service.js',()=>({__esModule:true,default:{captureEvent:jest.fn(),captureError:jest.fn()}}));
beforeEach(()=>jest.clearAllMocks());
test('ObjectIds stay readable while credentials remain redacted',()=>{
 const id=new mongoose.Types.ObjectId('64f000000000000000000001');
 for(const sanitize of [sanitizeLogDetails,redactLogValue]){
  const result=sanitize({businessId:id,nested:{leadId:id},ids:[id],apiKey:id});
  expect(result.businessId).toBe(id.toHexString());expect(result.nested.leadId).toBe(id.toHexString());expect(result.ids).toEqual([id.toHexString()]);expect(result.apiKey.toLowerCase()).toContain('redacted');expect(JSON.stringify(result)).not.toContain('buffer');
 }
});
test.each([404,409,400,403,429])('expected %i remains observable without critical unhandled alert',statusCode=>{
 const res={status:jest.fn().mockReturnThis(),json:jest.fn()};errorHandler({statusCode,code:'EXPECTED',message:'Request rejected'}, {path:'/appointments',originalUrl:'/appointments?secret=value'},res,jest.fn());
 expect(res.status).toHaveBeenCalledWith(statusCode);expect(Monitoring.captureError).not.toHaveBeenCalled();expect(Monitoring.captureEvent).toHaveBeenCalledWith('api_request_rejected',expect.objectContaining({statusCode,path:'/appointments'}),[404,409].includes(statusCode)?'info':'warn');
});
test('unexpected failure still triggers critical capture without disclosing details',()=>{
 const res={status:jest.fn().mockReturnThis(),json:jest.fn()};errorHandler(new Error('private'),{path:'/appointments'},res,jest.fn());expect(Monitoring.captureError).toHaveBeenCalledWith('unhandled_api_error',expect.any(Error),expect.objectContaining({statusCode:500}));expect(res.json.mock.calls[0][0].message).not.toContain('private');
});
