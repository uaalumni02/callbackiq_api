import { createTenantRecord, updateTenantRecord, updateTenantRecords, deleteTenantRecord, deleteTenantConversationRecords } from '../../services/stateTransitions/tenantRecords.js';
import mongoose from 'mongoose';
import logger from '../../config/logger.js';
import { assertTenantReferences } from '../../services/tenantReferences.service.js';
const atomicOperators = new Set(['$set', '$unset', '$inc', '$min', '$max']);
const fieldName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const failure = (code, message) => Object.assign(new TypeError(message), {
  code,
  isJoi: code === 'INVALID_TENANT_UPDATE'
});
const scalarId = value => Boolean(value && (typeof value === 'string' || typeof value.toHexString === 'function') && mongoose.isValidObjectId(value));
/** @typedef {{businessId:import('mongoose').Types.ObjectId|string}} TenantContext */
export function tenantContext(businessId) {
  if (!scalarId(businessId)) throw failure('TENANT_CONTEXT_REQUIRED', 'A concrete business identity is required.');
  return Object.freeze({
    businessId: String(businessId)
  });
}
function checkedUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw failure('INVALID_TENANT_UPDATE', 'An explicit update is required.');
  const keys = Object.keys(update),
    atomic = keys.some(key => key.startsWith('$'));
  if (!keys.length || atomic && keys.some(key => !atomicOperators.has(key))) throw failure('INVALID_TENANT_UPDATE', 'Unsupported tenant update operator.');
  const normalized = atomic ? update : {
    $set: update
  };
  for (const changes of Object.values(normalized)) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw failure('INVALID_TENANT_UPDATE', 'Update fields must be explicit.');
    for (const field of Object.keys(changes)) if (!fieldName.test(field) || /^(?:_id|business)(?:\.|$)/.test(field) || field.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) {
      throw failure('INVALID_TENANT_UPDATE', 'A tenant update cannot change document or business identity.');
    }
  }
  return normalized;
}
function populateForTenant(query, model, business, populate = []) {
  for (const entry of populate) {
    const spec = typeof entry === 'string' ? {
      path: entry
    } : {
      ...entry
    };
    const ref = model.schema.path(spec.path)?.options.ref;
    if (spec.path === 'business') spec.match = {
      ...spec.match,
      _id: business
    };else if (typeof ref === 'string' && model.db.models[ref]?.schema.path('business')) spec.match = {
      ...spec.match,
      business
    };
    query.populate(spec);
  }
  return query;
}
function checkedReferences(model, business, fields) {
  const references = Object.fromEntries(['lead', 'conversation'].filter(field => model.schema.path(field) && fields?.[field]).map(field => [field, fields[field]]));
  return assertTenantReferences(business, references);
}
function queryOptions(query, scope, {
  populate = [],
  select,
  sort,
  limit,
  skip,
  maxTimeMS
} = {}) {
  populateForTenant(query, scope.model, scope.business, populate);
  if (select) query.select(select);
  if (sort) query.sort(sort);
  if (limit !== undefined) query.limit(limit);
  if (skip !== undefined) query.skip(skip);
  if (maxTimeMS !== undefined) query.maxTimeMS(maxTimeMS);
  return query.lean();
}
function reads(scope) {
  const read = (id, options) => queryOptions(scope.model.findOne(scope.identity(id)), scope, options);
  return {
    async read(id, options) {
      return read(id, options);
    },
    async readForAccess(id, options) {
      const record = await read(id, options);
      if (record) return {
        outcome: 'owned',
        record
      };
      // Preserve missing/forbidden responses without materializing foreign data.
      const exists = await scope.model.exists({
        [scope.identityField]: id,
        ...scope.visibility
      });
      return {
        outcome: exists ? 'forbidden' : 'missing',
        record: null
      };
    },
    async first(criteria = {}, options) {
      return queryOptions(scope.model.findOne(scope.conditions(criteria)), scope, options);
    },
    async list(criteria = {}, options) {
      return queryOptions(scope.model.find(scope.conditions(criteria)), scope, options);
    },
    async count(criteria = {}) {
      return scope.model.countDocuments(scope.conditions(criteria));
    }
  };
}
function writes(scope) {
  const {
    model,
    business
  } = scope;
  return {
    async create(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.business && String(data.business) !== String(business)) throw failure('INVALID_TENANT_UPDATE', 'Creation requires the bound business identity.');
      await checkedReferences(model, business, data);
      const record = await createTenantRecord({ business, data, model });
      return record.toObject();
    },
    async update(id, update, options) {
      const filter = scope.identity(id),
        changes = checkedUpdate(update);
      await checkedReferences(model, business, changes.$set);
      return queryOptions(updateTenantRecord({ changes, filter, model }), scope, options);
    },
    async updateObserved(id, update, observed, options) {
      if (!observed?.updatedAt || !Number.isFinite(+new Date(observed.updatedAt)) || typeof observed.status !== 'string') {
        throw failure('INVALID_TENANT_UPDATE', 'An observed version and status are required.');
      }
      const filter = { ...scope.identity(id), updatedAt: observed.updatedAt, status: observed.status,
        ...(Number.isInteger(observed.stateVersion) ? { stateVersion: observed.stateVersion } : {}) };
      const changes = checkedUpdate(update);
      await checkedReferences(model, business, changes.$set);
      return queryOptions(updateTenantRecord({ changes, filter, model }), scope, options);
    },
    async updateMany(criteria, update) {
      const changes = checkedUpdate(update);
      await checkedReferences(model, business, changes.$set);
      return updateTenantRecords({ changes, criteria, model, scope });
    },
    async remove(id) {
      return deleteTenantRecord({ id, model, scope }).lean();
    },
    async removeManyByReference(field, id) {
      if (field !== 'conversation' || !model.schema.path(field) || !scalarId(id)) throw failure('INVALID_TENANT_REFERENCE', 'A concrete conversation reference is required.');
      return deleteTenantConversationRecords({ business, field, id, model });
    }
  };
}
function capabilities(scope) {
  const operations = {
    ...reads(scope),
    ...writes(scope)
  };
  return Object.freeze(Object.fromEntries(Object.entries(operations).map(([operation, execute]) => [operation, async (...args) => {
    try {
      return await execute(...args);
    } catch (error) {
      logger.error('repository.tenant_operation_failed', {
        businessId: String(scope.business),
        resourceType: scope.model.modelName,
        operation,
        code: error.code || 'TENANT_REPOSITORY_FAILED'
      });
      throw error;
    }
  }])));
}
/** Owner operations bind context before resource IDs, return plain records,
 * and never expose Mongoose builders/documents, upserts or ID-only fallbacks.
 * @param {import('mongoose').Model<any>} model
 * @param {TenantContext} context
 * @param {{identityField?:'_id'|'conversation'}} options
 */
export function tenantRepository(model, context, {
  identityField = '_id'
} = {}) {
  const {
    businessId
  } = tenantContext(context?.businessId);
  if (!model.schema.path('business') || !['_id', 'conversation'].includes(identityField) || !model.schema.path(identityField)) throw failure('INVALID_TENANT_MODEL', 'An explicitly tenant-owned model and identity are required.');
  const business = new mongoose.Types.ObjectId(businessId),
    visibility = model.schema.path('deletedAt') ? {
      deletedAt: null
    } : {};
  const scope = {
    model,
    business,
    identityField,
    visibility,
    identity(id) {
      if (!scalarId(id)) throw failure('TENANT_RESOURCE_ID_REQUIRED', 'A concrete resource identity is required.');
      return {
        [identityField]: id,
        business,
        ...visibility
      };
    },
    conditions(criteria) {
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw failure('INVALID_TENANT_QUERY', 'Explicit query criteria are required.');
      return {
        business,
        ...visibility,
        $and: [criteria]
      };
    }
  };
  return capabilities(scope);
}
