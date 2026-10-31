import { findBookingConversation } from '../../src/services/booking/bookingConversation.repository.js';
import Conversation from '../../src/models/conversation.js';
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
test('existing conversation bypasses database',async()=>{const existing={_id:'c1'};await expect(findBookingConversation({conversation:existing})).resolves.toBe(existing);expect(Conversation.findOne).not.toHaveBeenCalled();});
test('no lead identity cannot query another customer',async()=>{await expect(findBookingConversation({lead:null, business:{_id:'t'}})).resolves.toBeNull();expect(Conversation.findOne).not.toHaveBeenCalled();});
test('database query preserves tenant, lead, open status and ordering',async()=>{const sort=jest.fn().mockResolvedValue({_id:'matched'});Conversation.findOne.mockReturnValue({sort});await expect(findBookingConversation({business:{_id:'tenant'},lead:{_id:'lead'}})).resolves.toEqual({_id:'matched'});expect(Conversation.findOne).toHaveBeenCalledWith({business:'tenant',lead:'lead',status:'open'});expect(sort).toHaveBeenCalledWith({lastMessageAt:-1});});
