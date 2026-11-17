import mongoose from 'mongoose';

const installed = Symbol.for('meekcall.tenantContextGuard');
const missingTenant = () => Object.assign(new Error('An explicit business context is required.'), {
  code: 'TENANT_CONTEXT_REQUIRED', statusCode: 403,
});

// Inspect before Mongoose casts/removes undefined values, including logical predicates.
export function assertTenantFilter(filter) {
  if (!filter || typeof filter !== 'object') return;
  if (Object.hasOwn(filter, 'business')) {
    const value = filter.business;
    if (value == null || (typeof value === 'object' &&
      (Object.hasOwn(value, '$eq') && value.$eq == null ||
       Array.isArray(value.$in) && value.$in.some(item => item == null)))) throw missingTenant();
  }
  for (const operator of ['$and', '$or', '$nor']) {
    if (Array.isArray(filter[operator])) filter[operator].forEach(assertTenantFilter);
  }
}

export function tenantContextGuard(schema) {
  if (!schema.path('business')) return;
  for (const operation of ['find', 'findOne', 'count', 'countDocuments', 'distinct',
    'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
    'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete']) {
    schema.pre(operation, function requireTenantContext() {
      const options = this.getOptions();
      const allowed = options.allowCrossTenant === true;
      delete options.allowCrossTenant; // Application-only option; never send it to MongoDB.
      if (!allowed) assertTenantFilter(this.getFilter());
    });
  }
  schema.pre('aggregate', function requireAggregateTenantContext() {
    const allowed = this.options.allowCrossTenant === true;
    delete this.options.allowCrossTenant;
    if (!allowed) assertTenantFilter(this.pipeline()[0]?.$match);
  });
}

if (!mongoose[installed]) {
  mongoose.plugin(tenantContextGuard);
  mongoose[installed] = true;
}
