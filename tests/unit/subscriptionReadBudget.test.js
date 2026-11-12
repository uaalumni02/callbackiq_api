import mongoose from 'mongoose';
import Db from '../../src/db/db.js';
import Subscription from '../../src/models/subscription.js';
test('access-only subscription lookup avoids population; default callers keep it within the tenant',async()=>{
 const businessId=new mongoose.Types.ObjectId(),row={status:'active',business:businessId},populated={...row,business:{_id:businessId}};
 let result=row;
 const query={populate:jest.fn(()=>{result=populated;return query;}),lean:jest.fn(async()=>result)};
 const model={schema:Subscription.schema,db:Subscription.db,modelName:'Subscription',findOne:jest.fn(()=>query)};
 expect(await Db.getSubscriptionByBusiness(model,businessId,{populateBusiness:false})).toEqual(row);
 expect(query.populate).not.toHaveBeenCalled();
 expect(await Db.getSubscriptionByBusiness(model,businessId)).toEqual(populated);
 expect(query.populate).toHaveBeenCalledTimes(1);
 expect(query.populate).toHaveBeenCalledWith(expect.objectContaining({path:'business',match:{_id:businessId}}));
 expect(model.findOne).toHaveBeenCalledWith({business:businessId,$and:[{}]});
 await expect(Db.getSubscriptionByBusiness(model,undefined)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
});
