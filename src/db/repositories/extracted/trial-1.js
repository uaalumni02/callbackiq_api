/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbtrial1Methods(deps) {
  const { safeConsole } = deps;
  return {
async findTrialRedemption(model, { ownerId, emailKey, phoneKey }) {
    try {
      const conditions = [];

      if (ownerId) conditions.push({ owner: ownerId });
      if (emailKey) conditions.push({ emailKey });
      if (phoneKey) conditions.push({ phoneKey });

      if (!conditions.length) return null;

      return await model.findOne({ $or: conditions }).lean();
    } catch (error) {
      safeConsole.error("Error finding trial redemption:", error);
      throw error;
    }
  },

async createTrialRedemption(model, data) {
    try {
      const redemption = new model(data);
      return await redemption.save();
    } catch (error) {
      if (error?.code === 11000) {
        // Surface duplicate-key so the caller can return a clean 400.
        error.isDuplicateTrial = true;
      }

      safeConsole.error("Error creating trial redemption:", error);
      throw error;
    }
  }
  };
}
