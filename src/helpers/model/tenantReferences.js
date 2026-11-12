// Populate is a read boundary. Historical records may contain invalid links.
export function guardTenantReferences(schema, paths) {
  schema.path('business')?.immutable(true);
  schema.pre(/^find/, function scopePopulatedReferences() {
    const populated = this._mongooseOptions.populate || {};
    for (const path of paths) {
      if (!populated[path]) continue;
      const options = populated[path];
      const previous = options.match;
      const scopedBusiness=this.getFilter().business;
      const exactScope=scopedBusiness && (typeof scopedBusiness==='string' || typeof scopedBusiness.toHexString==='function');
      // A bound query already provides the owner identity. Keep it as a static
      // populate predicate: a per-document match also evaluates the selected
      // child fields and can discard owned records when business is unselected.
      if(exactScope && typeof previous!=='function'){
        this.populate({...options,path,match:{...previous,business:scopedBusiness}});
        continue;
      }
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
