// Explicit owner-approved offerings for provider-isolated conversation regressions.
// This is test data only; production never infers offerings from businessType.
export const approvedOffering = (id, category, keywords = []) => ({
  _id: id, active: true, name: `${category.replace('_', ' ')} service`, category,
  aiCanDiscuss: true, aiCanBook: true, disclosePriceEstimate: false,
  excludedKeywords: [], keywords,
});
export const catalogQuery = value => ({
  lean: jest.fn().mockResolvedValue(value), select() { return this; },
});
