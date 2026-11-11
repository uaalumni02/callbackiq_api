export const PROVIDER_CAPABILITIES = Object.freeze({
  internal: { availabilityAuthority: 'local', confirmation: 'recoverable', configured: true },
  google_calendar: { availabilityAuthority: 'external_calendar', confirmation: 'recoverable', configured: true },
  jobber: { availabilityAuthority: 'local', confirmation: 'verify_external_record', configured: true },
  housecall_pro: { availabilityAuthority: 'unavailable', confirmation: 'unavailable', configured: false },
  servicetitan: { availabilityAuthority: 'unavailable', confirmation: 'unavailable', configured: false },
});
export function providerCapabilities(name) {
  const capabilities = PROVIDER_CAPABILITIES[name];
  if (!capabilities) throw new Error(`No scheduling capability contract for ${name}`);
  return Object.freeze({ ...capabilities });
}
