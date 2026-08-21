// CALLBACKIQ_PRODUCTION_HARDENING_V1
import mongoose from "mongoose";

const productionOperationLeaseSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    ownerToken: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    collection: "production_operation_leases",
    timestamps: true,
    versionKey: false,
  },
);

productionOperationLeaseSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "expires_at_ttl" },
);

const ProductionOperationLease =
  mongoose.models.ProductionOperationLease ||
  mongoose.model("ProductionOperationLease", productionOperationLeaseSchema);

export default ProductionOperationLease;
