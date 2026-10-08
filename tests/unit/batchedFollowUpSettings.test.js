import Business from '../../src/models/business.js';
import {readFreshFollowUpSettings} from '../../src/services/database/followUpSettingsRead.js';
jest.mock('../../src/models/business.js',()=>({__esModule:true,default:{find:jest.fn(),findById:jest.fn()}}));
const query=value=>({select:()=>({lean:async()=>value})});
beforeEach(()=>jest.clearAllMocks());
test('maps unordered rows to exact business IDs, handles missing business, isolates duplicate callers',async()=>{
 Business.find.mockReturnValue(query([{_id:'b',features:{automatedFollowUpEnabled:false}},{_id:'a',features:{automatedFollowUpEnabled:true}}]));
 const [a,b,missing,duplicate]=await Promise.all(['a','b','missing','a'].map(readFreshFollowUpSettings));
 expect(a.features.automatedFollowUpEnabled).toBe(true);expect(b.features.automatedFollowUpEnabled).toBe(false);expect(missing).toBeNull();
 a.features.automatedFollowUpEnabled=false;expect(duplicate.features.automatedFollowUpEnabled).toBe(true);
 expect(Business.find).toHaveBeenCalledTimes(1);
 Business.findById.mockReturnValue(query({_id:'a',features:{automatedFollowUpEnabled:false}}));
 expect((await readFreshFollowUpSettings('a')).features.automatedFollowUpEnabled).toBe(false);
});
