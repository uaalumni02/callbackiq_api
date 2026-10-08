import Db from '../../src/db/db.js';
test('access-only subscription lookup avoids population; default callers keep it',async()=>{
 const row={status:'active',business:'business-id'};
 const populate=jest.fn().mockResolvedValue({...row,business:{_id:'business-id'}});
 const query=Object.assign(Promise.resolve(row),{populate});
 const model={findOne:jest.fn(()=>query)};
 expect(await Db.getSubscriptionByBusiness(model,'business-id',{populateBusiness:false})).toEqual(row);
 expect(populate).not.toHaveBeenCalled();
 expect(await Db.getSubscriptionByBusiness(model,'business-id')).toEqual({...row,business:{_id:'business-id'}});
 expect(populate).toHaveBeenCalledTimes(1);
 expect(model.findOne).toHaveBeenCalledWith({business:'business-id'});
});
