const identity = value => value?._id || value;
const conflict = () => Object.assign(new Error('This record changed. Reload before submitting again.'), { statusCode: 409, code: 'STATE_VERSION_CONFLICT' });
function hideVersion(schema, format) {
  const prior = schema.get(format) || {};
  schema.set(format, { ...prior, transform(doc, value, options) {
    const result = prior.transform ? prior.transform(doc, value, options) || value : value;
    delete result.stateVersion; return result;
  } });
}
/** Query writes advance a private version; document saves must own the observed version and tenant. */
export function installDocumentFence(schema) {
  schema.add({ stateVersion: { type: Number, default: 0, select: false } });
  hideVersion(schema, 'toJSON'); hideVersion(schema, 'toObject');
  for (const operation of ['find', 'findOne']) schema.pre(operation, function () {
    if (!this.mongooseOptions().lean) this.select('+stateVersion');
  });
  const remember = doc => {
    doc.$locals.stateFence = { version: doc.stateVersion || 0, business: identity(doc.business) };
    if (Object.hasOwn(doc.$locals, 'stateFencePrior')) { doc.$where = doc.$locals.stateFencePrior; delete doc.$locals.stateFencePrior; }
  };
  schema.post('init', remember); schema.post('save', remember);
  schema.post('save', function (error, doc, next) {
    if (Object.hasOwn(doc.$locals, 'stateFencePrior')) { doc.$where = doc.$locals.stateFencePrior; delete doc.$locals.stateFencePrior; }
    next(error);
  });
  schema.pre('save', function () {
    if (this.isNew) return;
    const observed = this.$locals.stateFence;
    if (!observed || String(observed.business) !== String(identity(this.business))) throw conflict();
    const claim = { business: observed.business, $or: [{ stateVersion: observed.version }, { stateVersion: { $exists: false } }] };
    this.$locals.stateFencePrior = this.$where;
    this.$where = { $and: [this.$where || {}, claim] };
    this.stateVersion = observed.version + 1;
  });
  for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate']) schema.pre(operation, function () {
    const update = this.getUpdate();
    if (Array.isArray(update)) update.push({ $set: { stateVersion: { $add: [{ $ifNull: ['$stateVersion', 0] }, 1] } } });
    else {
      if (update.$set && Object.hasOwn(update.$set, 'stateVersion')) throw conflict();
      update.$inc = { ...update.$inc, stateVersion: 1 };
    }
  });
}
