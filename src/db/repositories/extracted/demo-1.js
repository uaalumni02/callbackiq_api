/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbdemo1Methods(deps) {
  const { safeConsole } = deps;
  return {
async updateDemoRequest(model, id, data) {
    try {
      return await model.findByIdAndUpdate(id, data, {
        returnDocument: "after",
        runValidators: true,
      });
    } catch (error) {
      safeConsole.error("Error updating demo request:", error);
      throw error;
    }
  }
  };
}
