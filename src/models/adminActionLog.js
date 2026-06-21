import mongoose from "mongoose";

const adminActionLogSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    targetBusiness: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
    },
    action: {
      type: String,
      required: true,
      enum: [
        "view_dashboard",
        "view_customer",
        "update_subscription_status",
        "update_business_status",
      ],
    },
    message: {
      type: String,
      default: "",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

export default mongoose.model("AdminActionLog", adminActionLogSchema);