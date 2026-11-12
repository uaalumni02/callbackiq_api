import { tenantContext, tenantRepository } from '../../db/repositories/tenantRepository.js';
import * as Response from '../../helpers/response/response.js';
import { OWNER_RESOURCE_POPULATIONS } from '../../db/repositories/dbProjectionFields.js';

/** HTTP adapter for the repository's explicit access outcome. Foreign documents
 * are never materialized. Existing missing/denied response contracts stay stable. */
export async function readTenantResource({
  model,
  businessId,
  id,
  res,
  missingMessage,
  deniedMessage,
  populate = OWNER_RESOURCE_POPULATIONS[model.modelName] || [],
  select,
  identityField = '_id',
  populateBusiness = true,
  populateLead = true,
  populateArchivedBy = true
}) {
  const enabled = {
    business: populateBusiness,
    lead: populateLead,
    archivedBy: populateArchivedBy
  };
  const projection = populate.filter(spec => enabled[spec.path] !== false);
  const access = await tenantRepository(model, tenantContext(businessId), {
    identityField
  }).readForAccess(id, {
    populate: projection,
    select
  });
  if (access.outcome === 'owned') return access.record;
  if (access.outcome === 'forbidden') Response.responseBadAuth(res, deniedMessage);else Response.responseInvalidInput(res, missingMessage);
  return null;
}
