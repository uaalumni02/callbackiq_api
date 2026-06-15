import bcryptjs from "bcryptjs";

class bcrypt {
  static async hashPassword(password, saltRounds = 10) {
    return await bcryptjs.hash(password, saltRounds);
  }

  static async comparePassword(password, hashedPassword) {
    return await bcryptjs.compare(password, hashedPassword);
  }
}

export default bcrypt;
