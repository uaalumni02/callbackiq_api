import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const DB_URL = process.env.MONGO_URL;

    if (!DB_URL) {
      throw new Error("MONGO_URL is missing from .env");
    }

    await mongoose.connect(DB_URL);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
