import IntakeReviewController from '../../src/controllers/intakeReview.js';
import getOwnedBusiness from '../../src/services/businessScope.service.js';
import { approveIntake } from '../../src/services/booking/intakeReview.service.js';
jest.mock('../../src/services/businessScope.service.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/services/booking/intakeReview.service.js',()=>({approveIntake:jest.fn()}));
beforeEach(()=>jest.clearAllMocks());
test('passes authenticated staff identity and returns actual notice state',async()=>{
 const req={user:{userId:'owner'},params:{id:'conversation'},body:{businessId:'business',serviceOfferingId:'service'}};
 const res={status:jest.fn().mockReturnThis(),json:jest.fn()};const next=jest.fn();
 getOwnedBusiness.mockResolvedValue({_id:'business'});
 approveIntake.mockResolvedValue({appointment:{_id:'appointment',status:'confirmed'},confirmationNoticeStatus:'failed'});
 await IntakeReviewController.approveIntake(req,res,next);
 expect(getOwnedBusiness).toHaveBeenCalledWith({user:req.user,requestedBusinessId:'business'});
 expect(approveIntake).toHaveBeenCalledWith({business:{_id:'business'},conversationId:'conversation',input:req.body,approvedBy:'owner'});
 expect(res.json).toHaveBeenCalledWith({success:true,data:{_id:'appointment',status:'confirmed'},confirmationNoticeStatus:'failed'});
});
test('does not execute booking when ownership resolution fails',async()=>{
 const denied=Object.assign(new Error('Business not found'),{statusCode:404});getOwnedBusiness.mockRejectedValue(denied);
 const next=jest.fn();await IntakeReviewController.approveIntake({user:{userId:'stranger'},params:{id:'conversation'},body:{}},{},next);
 expect(next).toHaveBeenCalledWith(denied);expect(approveIntake).not.toHaveBeenCalled();
});
