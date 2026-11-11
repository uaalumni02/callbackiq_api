import { canonicalPhone } from './phoneIdentity.js';
// Compatibility lookup normalization. Outbound identities use strict canonicalPhone.
export const normalizePhone = value => canonicalPhone(value, { strict: false });
export default normalizePhone;
