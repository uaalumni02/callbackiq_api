import mongoose from "mongoose";
const schema = new mongoose.Schema(
  { _id: String, afterId: mongoose.Schema.Types.ObjectId },
  { timestamps: true, versionKey: false },
);
export default mongoose.models.StaffNotificationCursor ||
  mongoose.model("StaffNotificationCursor", schema);
