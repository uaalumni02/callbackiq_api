import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    _id: String,
    lastStartedAt: Date,
    lastSucceededAt: Date,
    lastFailedAt: Date,
    lastErrorCode: String,
    summary: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true, versionKey: false },
);
export default mongoose.models.MaintenanceTaskHeartbeat ||
  mongoose.model("MaintenanceTaskHeartbeat", schema);
