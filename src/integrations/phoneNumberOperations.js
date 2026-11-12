/** Known rejection, absence and uncertain destructive outcomes have distinct contracts. */
export async function removeProviderNumber(client, sid) {
  try {
    const removed = await client.incomingPhoneNumbers(sid).remove();
    return removed === true ? { outcome: 'absent', evidence: 'removed' }
      : { outcome: 'uncertain', errorCode: 'PROVIDER_REMOVAL_NOT_VERIFIED' };
  }
  catch (error) {
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 404) return { outcome: 'absent', evidence: 'already_absent' };
    return { outcome: status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'uncertain',
      errorCode: String(error?.code || status || 'PROVIDER_OUTCOME_UNKNOWN') };
  }
}
export async function inspectProviderNumber(client, sid) {
  try {
    const number = await client.incomingPhoneNumbers(sid).fetch();
    return number?.sid === sid ? { outcome: 'present' } : { outcome: 'uncertain', errorCode: 'PROVIDER_IDENTITY_MISMATCH' };
  } catch (error) {
    if (Number(error?.status || error?.statusCode) === 404) return { outcome: 'absent', evidence: 'lookup_absent' };
    return { outcome: 'uncertain', errorCode: String(error?.code || 'PROVIDER_LOOKUP_FAILED') };
  }
}
