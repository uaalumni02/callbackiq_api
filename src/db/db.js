class Db {
  static async findUserByEmailOrUserName(model, userName, email) {
    try {
      return await model.findOne({
        $or: [{ userName }, { email }],
      });
    } catch (error) {
      throw new Error("Database error while finding user");
    }
  }

  static async findUserByLogin(model, login) {
    try {
      return await model.findOne({
        $or: [{ userName: login }, { email: login }],
      });
    } catch (error) {
      throw new Error("Database error while finding user");
    }
  }

  static async saveUser(model, userData) {
    try {
      const user = new model(userData);
      return await user.save();
    } catch (error) {
      console.error("Actual Mongoose Save Error:", error);
      throw error;
    }
  }

  static async getUserById(model, id) {
    try {
      return await model.findById(id).select("-password");
    } catch (error) {
      throw new Error("Database error while fetching user");
    }
  }
}

export default Db;
