// Validate shape before coverage checks so malformed client input cannot be
// mistaken for an unsupported or unverified service area.
export const normalizeAppointmentAddress = (address = {}) => {
  const invalid = () => Object.assign(new Error('address must be an object with street, city, state and postalCode fields; send each supplied field as text.'), {
    statusCode: 400, code: 'INVALID_APPOINTMENT_ADDRESS',
  });
  if (address === null || typeof address !== 'object' || Array.isArray(address)) throw invalid();
  const result = {};
  for (const field of ['street', 'city', 'state', 'postalCode']) {
    const value = address[field];
    if (value !== undefined && value !== null && typeof value !== 'string') throw invalid();
    result[field] = (value || '').trim();
  }
  // Required fields and geographic eligibility remain scheduling-policy checks.
  return result;
};
