import Joi from 'joi';
import mongoose from 'mongoose';
import Business from '../models/business.js';
import AdminActionLog from '../models/adminActionLog.js';
import Db from '../db/db.js';
import { BUSINESS_FEATURE_DEFAULTS, getBusinessFeatures } from '../helpers/businessFeatures.js';
import { updateBusinessFeatures } from '../services/stateTransitions/accountRecords.js';

const schema = Joi.object({ features: Joi.object(Object.fromEntries(
  Object.entries(BUSINESS_FEATURE_DEFAULTS).filter(([, value]) => typeof value === 'boolean')
    .map(([key]) => [key, Joi.boolean().strict()]),
)).min(1).required().unknown(false) }).required().unknown(false);

export async function patchBusinessFeatures(req, res, next) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid business ID' });
    const { features } = await schema.validateAsync(req.body);
    if(features.jobberEnabled===true)return res.status(403).json({success:false,message:"Jobber is disabled for the supervised pilot."});
    const business = await updateBusinessFeatures({ Business, businessId: req.params.id, features });
    if (!business) return res.status(404).json({ success: false, message: 'Not found' });
    await Db.createAdminActionLog(AdminActionLog, { admin: req.user.userId, targetBusiness: business._id,
      action: 'update_business_features', message: 'Business feature settings updated', metadata: { features } });
    return res.json({ success: true, data: { features: getBusinessFeatures(business) } });
  } catch (error) {
    if (error.isJoi) return res.status(400).json({ success: false, message: error.message });
    return next(error);
  }
}
