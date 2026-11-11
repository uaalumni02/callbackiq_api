// Populate is a read boundary. Historical records may contain invalid links.
export function guardTenantReferences(schema, paths) {
  schema.path('business')?.immutable(true);
  schema.pre(/^find/, function scopePopulatedReferences() {
    const populated = this._mongooseOptions.populate || {};
    for (const path of paths) {
      if (!populated[path]) continue;
      const options = populated[path];
      const previous = options.match;
      this.populate({
        ...options,
        path,
        match(document) {
          const business = document.business?._id || document.business;
          const filter = typeof previous === 'function' ? previous(document) : previous;
          return { ...filter, business: business || null };
        },
      });
    }
  });
}
