import { isBusinessFeatureEnabled } from '../helpers/businessFeatures.js';

export const requireBusinessFeature = name => (req, res, next) => {
  if (req.user?.role === 'admin' || isBusinessFeatureEnabled(req.business, name)) return next();
  return res.status(404).type('application/json').send(JSON.stringify({ success: false, message: 'Not found' }));
};
export default requireBusinessFeature;
