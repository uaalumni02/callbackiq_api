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
      default: null,
    },

    action: {
      type: String,
      required: true,
      enum: [
        "view_dashboard",
        "view_customer",
        "update_subscription_status",
        "update_business_status",
        "update_reporting_profile",
        "update_reporting_cost",
        "update_company_expense",
        "update_provider_balance",
        "remove_provider_balance",
        "refresh_provider_balances",
        "refresh_company_expenses",
        "remove_expense_override",
      ],
    },

    message: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports viewing an administrator's most recent actions.
 */
adminActionLogSchema.index({
  admin: 1,
  createdAt: -1,
});

/*
 * Supports a customer/business audit timeline.
 */
adminActionLogSchema.index({
  targetBusiness: 1,
  createdAt: -1,
});

/*
 * Supports filtering the audit log by action type.
 */
adminActionLogSchema.index({
  action: 1,
  createdAt: -1,
});

const AdminActionLog =
  mongoose.models.AdminActionLog ||
  mongoose.model("AdminActionLog", adminActionLogSchema);

export default AdminActionLog;
