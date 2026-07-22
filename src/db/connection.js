import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const DB_URL = process.env.MONGO_URL;

    if (!DB_URL) {
      throw new Error("MONGO_URL is missing from .env");
    }

    await mongoose.connect(DB_URL, {
      /*
       * Automatically creates indexes declared in Mongoose models during
       * local development and testing. Production indexes should be created
       * through a controlled deployment or migration process.
       */
      autoIndex: process.env.NODE_ENV !== "production",
    });

    console.log("Connected to MongoDB");
    console.log(
      `Automatic index creation is ${
        process.env.NODE_ENV !== "production" ? "enabled" : "disabled"
      }`,
    );
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
