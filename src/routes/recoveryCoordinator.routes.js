import express from 'express';
import checkAuth from '../middleware/check-auth.js';
import checkSubscription from '../middleware/check-subscription.js';
import getOwnedBusiness from '../services/businessScope.service.js';
import {initializeRecoveryCase,readRecoveryCase,applyRecoveryOperation,listRecoveryEvents,requireCoordinatorEnabled} from '../services/recoveryCoordinator/recoveryCoordinator.service.js';

const router = express.Router();
router.use(checkAuth,checkSubscription);
const wrap = handler => async(req,res,next)=>{try{
  const business=await getOwnedBusiness({user:req.user,requestedBusinessId:req.query.businessId});
  requireCoordinatorEnabled(business._id);
  const data=await handler({businessId:business._id,userId:req.user?.userId,req});
  return res.json({success:true,data});
}catch(error){next(error);}};
router.post('/conversations/:conversationId/initialize',wrap(({businessId,req})=>initializeRecoveryCase({businessId,conversationId:req.params.conversationId})));
router.get('/conversations/:conversationId',wrap(({businessId,req})=>readRecoveryCase({businessId,conversationId:req.params.conversationId})));
router.get('/conversations/:conversationId/events',wrap(({businessId,req})=>listRecoveryEvents({businessId,conversationId:req.params.conversationId,limit:req.query.limit})));
router.post('/conversations/:conversationId/facts',wrap(({businessId,userId,req})=>applyRecoveryOperation({businessId,userId,conversationId:req.params.conversationId,
  version:req.body?.version,operationId:req.get('Idempotency-Key')||req.body?.operationId,action:'facts',payload:req.body?.changes})));
router.post('/conversations/:conversationId/service-decision',wrap(({businessId,userId,req})=>applyRecoveryOperation({businessId,userId,conversationId:req.params.conversationId,
  version:req.body?.version,operationId:req.get('Idempotency-Key')||req.body?.operationId,action:'decision',payload:req.body})));
export default router;
