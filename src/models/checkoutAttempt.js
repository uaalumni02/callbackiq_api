import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
    },
    attemptStartedAt: { type: Date, required: true },
    generation: { type: Number, min: 1, required: true },
    purpose: { type: String, enum: ["trial", "paid"], required: true },
    state: {
      type: String,
      enum: ["creating", "open", "complete", "expired"],
      required: true,
    },
    idempotencyKey: { type: String, required: true },
    sessionId: { type: String, default: "" },
    url: { type: String, default: "" },
    params: { type: mongoose.Schema.Types.Mixed, select: false },
    history: [
      { generation: Number, state: String, sessionId: String, _id: false },
    ],
  },
  { timestamps: true },
);
export default mongoose.models.CheckoutAttempt ||
  mongoose.model("CheckoutAttempt", schema);
