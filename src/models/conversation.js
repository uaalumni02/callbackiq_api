import mongoose from "mongoose";

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
    postalCode: { type: String, trim: true, default: "" },
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
    lead: { type: Schema.Types.ObjectId, ref: "Lead" },
    customerPhone: { type: String, required: true, trim: true },
    customerName: { type: String, trim: true, default: "Customer" },
    status: {
      type: String,
      enum: ["open", "closed", "archived"],
      default: "open",
    },
    aiEnabled: { type: Boolean, default: true },
    humanTakeover: { type: Boolean, default: false },
    bookingState: { type: BookingStateSchema, default: () => ({}) },
    lastMessage: { type: String, trim: true, default: "" },
    lastMessageAt: { type: Date, default: Date.now },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveSnapshot: { type: archiveSnapshotSchema, default: null },
  },
  { timestamps: true },
);

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

const Conversation =
  mongoose.models.Conversation ||
  mongoose.model("Conversation", conversationSchema);

export default Conversation;
