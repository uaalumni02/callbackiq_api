import Lead from '../../src/models/lead.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import { beginValuation, finishValuation, updateOwnerLead } from '../../src/services/valuation/opportunityValuation.service.js';
jest.mock('../../src/models/lead.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/models/serviceOffering.js',()=>({__esModule:true,default:{find:jest.fn()}}));
let row;
beforeEach(()=>{
 row={_id:'lead',business:'tenant',estimatedValue:null,valuation:{source:'unknown'},valuationVersion:0,serviceNeeded:'Drain cleaning'};
 ServiceOffering.find.mockImplementation(filter=>({lean:async()=>filter.business==='tenant'?[{_id:'svc',business:'tenant',active:true,name:'Drain cleaning',estimatedValue:225}]:[]}));
 Lead.findOneAndUpdate.mockImplementation((filter,update)=>{
  let result=null;
  if(filter._id===row._id && filter.business===row.business && (filter.valuationVersion===undefined || filter.valuationVersion===row.valuationVersion) && (!filter['valuation.source'] || filter['valuation.source'].$in.includes(row.valuation.source))){
   Object.assign(row,update.$set||{});row.valuationVersion+=(update.$inc?.valuationVersion||0);result=JSON.parse(JSON.stringify(row));
  }
  const promise=Promise.resolve(result);return {lean:()=>promise,populate:()=>promise,then:promise.then.bind(promise)};
 });
});
test('later ticket invalidates older result at the write filter',async()=>{const old=await beginValuation(row,'tenant'),newer=await beginValuation(row,'tenant');expect(await finishValuation(old,{businessId:'tenant',evidence:'Drain cleaning'})).toBeNull();await finishValuation(newer,{businessId:'tenant',evidence:'Drain cleaning'});expect(row.estimatedValue).toBe(225);expect(await finishValuation(old,{businessId:'tenant',evidence:'hello'})).toBeNull();});
test('owner zero wins and no automatic write can change it',async()=>{const ticket=await beginValuation(row,'tenant');await updateOwnerLead({lead:row,businessId:'tenant',changes:{estimatedValue:0}});expect(await finishValuation(ticket,{businessId:'tenant',evidence:'Drain cleaning'})).toBeNull();expect(row.estimatedValue).toBe(0);expect(row.valuation.source).toBe('owner');});
test('release re-enables catalog, unrelated edit does not claim value',async()=>{await updateOwnerLead({lead:row,businessId:'tenant',changes:{customerName:'New'}});expect(row.valuation.source).toBe('unknown');await updateOwnerLead({lead:row,businessId:'tenant',changes:{estimatedValue:999}});await updateOwnerLead({lead:row,businessId:'tenant',changes:{valuationAction:'automatic'}});expect(row.estimatedValue).toBe(225);expect(row.valuation.source).toBe('service_catalog');});
test('wrong tenant never writes',async()=>{expect(await beginValuation(row,'other')).toBeNull();expect(row.estimatedValue).toBeNull();});
