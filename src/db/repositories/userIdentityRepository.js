import { safeConsole } from '../../helpers/logging/safeLogger.js';
// Exact identity operations extracted from Db; errors and Mongoose operations unchanged.

export async findUserByEmailOrUserName(model, userName, email) {
    try {
      return await model.findOne({
        $or: [{ userName }, { email }],
      });
    } catch (error) {
      throw new Error("Database error while finding user");
    }
  }

export async saveUser(model, userData, { session = null } = {}) {
    try {
      const user = new model(userData);
      return await user.save(session ? { session } : undefined);
    } catch (error) {
      safeConsole.error("Actual Mongoose Save Error:", error);
      throw error;
    }
  }

export async getUserById(model, id) {
    try {
      return await model.findById(id).select("-password");
    } catch (error) {
      throw new Error("Database error while fetching user");
    }
  }
