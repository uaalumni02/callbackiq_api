import Business from '../models/business.js';
import { isBusinessFeatureEnabled } from '../helpers/businessFeatures.js';

export const enabledBusinessIds = name => Business.distinct('_id', { [`features.${name}`]: true });
export const businessHasFeature = async (businessId, name) => {
  const business = await Business.findById(businessId).select('features').lean();
  return isBusinessFeatureEnabled(business, name);
};
export const requireJobberBusiness = async businessId => {
  if (await businessHasFeature(businessId, 'jobberEnabled')) return;
  throw Object.assign(new Error('Jobber is not enabled for this business.'), { statusCode: 409, code: 'JOBBER_DISABLED' });
};
