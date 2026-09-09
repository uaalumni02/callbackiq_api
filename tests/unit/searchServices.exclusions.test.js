import ServiceOffering from '../../src/models/serviceOffering.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
jest.mock('../../src/models/serviceOffering.js',()=>({__esModule:true,default:{find:jest.fn()}}));
const offering={_id:'service',name:'Plumbing service',category:'Plumbing',keywords:['repair'],excludedKeywords:['septic']};
beforeEach(()=>{jest.clearAllMocks();ServiceOffering.find.mockReturnValue({lean:jest.fn().mockResolvedValue([offering])});});
test('sole service explicitly excluding request is never fallback eligible',async()=>{
 expect(await searchServices({businessId:'business',query:'Septic repair'})).toEqual([]);
 expect(ServiceOffering.find).toHaveBeenCalledWith({business:'business',active:true,aiCanBook:true});
});
test('blank exclusion entries do not veto all customer requests',async()=>{
 ServiceOffering.find.mockReturnValue({lean:jest.fn().mockResolvedValue([{...offering,excludedKeywords:['','  ',null]}])});
 expect(await searchServices({businessId:'business',query:'repair'})).toEqual([expect.objectContaining({id:'service',score:1})]);
});
test('preserves existing sole-service fallback without matching exclusions',async()=>{
 expect(await searchServices({businessId:'business',query:'a strange noise'})).toEqual([expect.objectContaining({id:'service',score:0})]);
});
test('does not fallback to one unexcluded service from several unrelated services',async()=>{
 ServiceOffering.find.mockReturnValue({lean:jest.fn().mockResolvedValue([offering,{...offering,_id:'other',excludedKeywords:[]}])});
 expect(await searchServices({businessId:'business',query:'septic inspection'})).toEqual([]);
});
