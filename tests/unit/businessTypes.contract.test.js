import { BUSINESS_TYPES } from '../../src/helpers/businessTypes.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import { isValidBusinessType } from '../../src/helpers/model/business.js';
test.each(BUSINESS_TYPES)('%s is accepted consistently by the persisted business model',businessType=>{
 expect(isValidBusinessType(businessType)).toBe(true);
 const doc=new Business({owner:'507f1f77bcf86cd799439011',businessName:'Test Service',businessType});
 expect(doc.validateSync()?.errors?.businessType).toBeUndefined();
 expect(User.schema.path('businessType').enumValues).toContain(businessType);
});
test('unknown values remain invalid',()=>expect(isValidBusinessType('unrelated_industry')).toBe(false));
