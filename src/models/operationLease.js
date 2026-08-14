import mongoose from "mongoose";

const { Schema } = mongoose;

const OperationLeaseSchema = new Schema(
  {
    _id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    token: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

OperationLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OperationLease =
  mongoose.models.OperationLease ||
  mongoose.model("OperationLease", OperationLeaseSchema);

export default OperationLease;
