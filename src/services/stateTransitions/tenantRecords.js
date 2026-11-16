// Tenant-bound repository transitions. Validation, authorization and logging remain at the repository boundary.

// src/db/repositories/privileged/adminRepository.js:37 — findByIdAndUpdate.
export function updatePrivilegedRecord({ input }) {
  return (input.model.findByIdAndUpdate(input.id, input.update, {
    returnDocument: 'after',
    runValidators: true
  }));
}

// src/db/repositories/privileged/adminRepository.js:46 — findByIdAndDelete.
export function deletePrivilegedRecord({ input }) {
  return (input.model.findByIdAndDelete(input.id));
}

// src/db/repositories/tenantRepository.js:116 — create.
export function createTenantRecord({ business, data, model }) {
  return (model.create({
        ...data,
        business
      }));
}

// src/db/repositories/tenantRepository.js:126 — findOneAndUpdate.
export function updateTenantRecord({ changes, filter, model }) {
  return (model.findOneAndUpdate(filter, changes, {
        returnDocument: 'after',
        runValidators: true
      }));
}

// src/db/repositories/tenantRepository.js:134 — updateMany.
export function updateTenantRecords({ changes, criteria, model, scope }) {
  return (model.updateMany(scope.conditions(criteria), changes, {
        runValidators: true
      }));
}

// src/db/repositories/tenantRepository.js:139 — findOneAndDelete.
export function deleteTenantRecord({ id, model, scope }) {
  return (model.findOneAndDelete(scope.identity(id)));
}

// src/db/repositories/tenantRepository.js:143 — deleteMany.
export function deleteTenantConversationRecords({ business, field, id, model }) {
  return (model.deleteMany({
        business,
        [field]: id
      }));
}

