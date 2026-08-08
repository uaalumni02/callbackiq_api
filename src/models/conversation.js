import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";
import mongoose from "mongoose";
import { customerLifecycleField } from "../helpers/customerLifecycle.js";

const { Schema } = mongoose;

const archiveSnapshotSchema = new Schema(
  {
    status: { type: String, enum: ["open", "closed"], required: true },
    aiEnabled: { type: Boolean, required: true },
    humanTakeover: { type: Boolean, required: true },
  },
  { _id: false },
);

const BookingSlotSchema = new Schema(
  {
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, default: "America/New_York" },
    label: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const BookingStateSchema = new Schema(
  {
    status: {
      type: String,
      enum: [
        "not_started",
        "collecting_service",
        "collecting_location",
        "collecting_street_address",
        "collecting_postal_code",
        "collecting_preference",
        "offering_slots",
        "awaiting_confirmation",
        "booking",
        "booked",
        "failed",
        "human_takeover",
      ],
      default: "not_started",
    },
    serviceOffering: {
      type: Schema.Types.ObjectId,
      ref: "ServiceOffering",
      default: null,
    },
    streetAddress: { type: String, trim: true, default: "" },
    postalCode: { type: String, trim: true, default: "" },
    timeOfDay: {
      type: String,
      enum: ["", "morning", "midday", "afternoon", "evening"],
      default: "",
    },
    preferredStart: { type: Date, default: null },
    preferredEnd: { type: Date, default: null },
    offeredSlots: { type: [BookingSlotSchema], default: [] },
    selectedSlot: { type: BookingSlotSchema, default: null },
    appointment: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    expiresAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: "" },
    negotiationAttempts: { type: Number, min: 0, default: 0 },
    lastCustomerPreference: { type: String, trim: true, maxlength: 500, default: "" },
    lastAvailabilityCheckedAt: { type: Date, default: null },
    escalatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    customerLifecycleStatus: { ...customerLifecycleField },
    lead: { type: Schema.Types.ObjectId, ref: "Lead" },
    customerPhone: { type: String, required: true, trim: true },
    customerPhoneLookup: { type: String, trim: true, default: "" },
    activeRecord: { type: Boolean, default: true },
    customerName: { type: String, trim: true, default: "Customer" },
    status: {
      type: String,
      enum: ["open", "closed", "archived"],
      default: "open",
    },
    aiEnabled: { type: Boolean, default: true },
    humanTakeover: { type: Boolean, default: false },
    humanTakeoverAt: { type: Date, default: null },
    humanTakeoverBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reopenedAt: { type: Date, default: null },
    reopenReason: { type: String, trim: true, maxlength: 120, default: "" },
    bookingState: { type: BookingStateSchema, default: () => ({}) },
    conversationMemory: {
      summary: { type: String, trim: true, maxlength: 2000, default: "" },
      serviceNeeded: { type: String, trim: true, maxlength: 200, default: "" },
      urgency: { type: String, trim: true, maxlength: 40, default: "" },
      address: { type: String, trim: true, maxlength: 500, default: "" },
      preferredAppointmentTime: { type: String, trim: true, maxlength: 500, default: "" },
      lastIntent: { type: String, trim: true, maxlength: 80, default: "" },
      confidence: { type: Number, min: 0, max: 100, default: 0 },
      lastUpdatedAt: { type: Date, default: null },
    },
    orchestration: {
      lastOutcome: { type: String, trim: true, maxlength: 80, default: "" },
      lastInboundMessage: { type: Schema.Types.ObjectId, ref: "Message", default: null },
      lastOutboundMessage: { type: Schema.Types.ObjectId, ref: "Message", default: null },
      silentFailureCount: { type: Number, min: 0, default: 0 },
      lastEscalatedAt: { type: Date, default: null },
    },
    lastMessage: { type: String, trim: true, default: "" },
    lastMessageAt: { type: Date, default: Date.now },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveSnapshot: { type: archiveSnapshotSchema, default: null },
  },
  { timestamps: true },
);

conversationSchema.pre("validate", function normalizeConversationIdentity() {
  const normalized = normalizePhoneToE164(this.customerPhone);
  if (normalized) {
    this.customerPhone = normalized;
    this.customerPhoneLookup = normalized;
  }
  this.activeRecord = this.status !== "archived";
});

const normalizeConversationUpdate = function normalizeConversationUpdate() {
  const update = this.getUpdate() || {};
  for (const target of [update, update.$set, update.$setOnInsert].filter(Boolean)) {
    if (target.customerPhone) {
      const normalized = normalizePhoneToE164(target.customerPhone);
      if (normalized) {
        target.customerPhone = normalized;
        target.customerPhoneLookup = normalized;
      }
    }
    if (target.status) target.activeRecord = target.status !== "archived";
  }
};
conversationSchema.pre("findOneAndUpdate", normalizeConversationUpdate);
conversationSchema.pre("updateOne", normalizeConversationUpdate);
conversationSchema.pre("updateMany", normalizeConversationUpdate);

const normalizeConversationPhoneFilter = function normalizeConversationPhoneFilter() {
  const filter = this.getFilter() || {};
  const normalizeTarget = (target) => {
    if (!target || typeof target !== "object") return;
    if (typeof target.customerPhone === "string") {
      const normalized = normalizePhoneToE164(target.customerPhone);
      if (normalized) target.customerPhone = normalized;
    }
  };
  normalizeTarget(filter);
  if (Array.isArray(filter.$or)) filter.$or.forEach(normalizeTarget);
};
for (const operation of ["find", "findOne", "countDocuments", "findOneAndDelete", "deleteOne"]) {
  conversationSchema.pre(operation, normalizeConversationPhoneFilter);
}

conversationSchema.index({
  business: 1,
  status: 1,
  lastMessageAt: -1,
  createdAt: -1,
});
conversationSchema.index({ business: 1, lastMessageAt: -1, createdAt: -1 });
conversationSchema.index({
  business: 1,
  customerPhone: 1,
  status: 1,
  lastMessageAt: -1,
});
conversationSchema.index({ business: 1, lead: 1, lastMessageAt: -1 });
conversationSchema.index({
  business: 1,
  "bookingState.status": 1,
  "bookingState.expiresAt": 1,
});

conversationSchema.index(
  { business: 1, customerPhoneLookup: 1, activeRecord: 1 },
  {
    unique: true,
    partialFilterExpression: {
      customerPhoneLookup: { $gt: "" },
      activeRecord: true,
    },
  },
);
const Conversation =
  mongoose.models.Conversation ||
  mongoose.model("Conversation", conversationSchema);

export default Conversation;
