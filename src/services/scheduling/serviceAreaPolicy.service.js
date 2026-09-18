import getPostalCodeDistanceMiles from '../location/postalCodeDistance.service.js';

export const SERVICE_AREA_POLICY_VERSION = 1;
const zipPattern = /^\d{5}(?:-\d{4})?$/;
const decision = (supported, reason, extra = {}) => ({
  supported, status: supported === true ? 'supported' : supported === false ? 'unsupported' : 'unknown',
  reason, policyVersion: SERVICE_AREA_POLICY_VERSION, ...extra,
});

// Missing configuration is not permission. All callers, including owner previews,
// use these same decisions. An explicit unrestricted policy is the only bypass.
export async function evaluateServiceAreaPolicy({ area, postalCode, distanceResolver = getPostalCodeDistanceMiles }) {
  const postal = String(postalCode || '').trim();
  if (!area) return decision(null, 'service_area_not_configured');
  if (postal && !zipPattern.test(postal)) return decision(null, 'invalid_postal_code');
  if (area.type === 'unrestricted') return decision(true, 'explicitly_unrestricted', { mode: area.type });
  if (!postal) return decision(null, 'zip_code_required');
  const zip = postal.slice(0, 5);
  if (area.type === 'zip_codes') {
    const codes = (Array.isArray(area.zipCodes) ? area.zipCodes : []).map(String).filter(code => zipPattern.test(code));
    if (!codes.length) return decision(null, 'service_area_not_configured', { mode: area.type });
    const supported = codes.some(code => code.slice(0, 5) === zip);
    return decision(supported, supported ? 'matched' : 'outside_configured_service_area', { mode: area.type });
  }
  if (area.type === 'radius') {
    const center = String(area.centerPostalCode || '').trim();
    const radius = Number(area.radiusMiles);
    if (!zipPattern.test(center) || !Number.isFinite(radius) || radius <= 0 || radius > 500) {
      return decision(null, 'service_area_configuration_incomplete', { mode: area.type });
    }
    try {
      const distance = await distanceResolver({ originPostalCode: center.slice(0, 5), destinationPostalCode: zip });
      if (!Number.isFinite(distance) || distance < 0) return decision(null, 'service_area_validation_unavailable', { mode: area.type });
      const supported = distance <= radius;
      return decision(supported, supported ? 'matched_radius' : 'outside_configured_service_area', {
        mode: area.type, distanceMiles: Number(distance.toFixed(2)), radiusMiles: radius, centerPostalCode: center.slice(0, 5),
      });
    } catch (error) {
      if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
      return decision(null, 'service_area_validation_unavailable', { mode: area.type });
    }
  }
  return decision(null, 'service_area_configuration_incomplete');
}
