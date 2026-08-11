import mongoose from "mongoose";

const DEMO_STATUSES = [
  "new",
  "contacted",
  "scheduled",
  "completed",
  "converted",
  "lost",
  "no_show",
  "cancelled",
  // Legacy value retained so historical records remain editable.
  "closed",
  "spam",
];

const MONTHLY_CALL_VOLUMES = [
  "",
  "under_100",
  "100_250",
  "250_500",
  "500_1000",
  "1000_plus",
];

const DEMO_OUTREACH_CHANNELS = ["phone", "email"];
const DEMO_OUTREACH_ACTIVITY_TYPES = [
  "call_initiated",
  "email_initiated",
  "email_sent",
];

const demoOutreachActivitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: DEMO_OUTREACH_ACTIVITY_TYPES,
      required: true,
    },
    channel: {
      type: String,
      enum: DEMO_OUTREACH_CHANNELS,
      required: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    actorEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    subject: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },
    at: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: true },
);

const normalizeDemoPhoneToE164 = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const compact = raw.replace(/[()\s.-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;

  return "";
};

const demoRequestSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
    },

    phoneE164: {
      type: String,
      trim: true,
      default: "",
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessType: {
      type: String,
      trim: true,
      default: "",
    },

    monthlyCallVolume: {
      type: String,
      enum: MONTHLY_CALL_VOLUMES,
      default: "",
      trim: true,
    },

    website: {
      type: String,
      trim: true,
      default: "",
    },

    message: {
      type: String,
      trim: true,
      default: "",
    },

    // Retained for backward compatibility with older demo requests.
    preferredTime: {
      type: String,
      trim: true,
      default: "",
    },

    visitorTimezone: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: DEMO_STATUSES,
      default: "new",
    },

    source: {
      type: String,
      default: "website",
      trim: true,
    },

    utmSource: {
      type: String,
      trim: true,
      default: "",
    },

    utmMedium: {
      type: String,
      trim: true,
      default: "",
    },

    utmCampaign: {
      type: String,
      trim: true,
      default: "",
    },

    utmContent: {
      type: String,
      trim: true,
      default: "",
    },

    referrer: {
      type: String,
      trim: true,
      default: "",
    },

    adminNotes: {
      type: String,
      trim: true,
      default: "",
    },

    contactedAt: {
      type: Date,
      default: null,
    },

    outreachActivities: {
      type: [demoOutreachActivitySchema],
      default: [],
    },

    lastOutreachAt: {
      type: Date,
      default: null,
    },

    lastOutreachChannel: {
      type: String,
      enum: [...DEMO_OUTREACH_CHANNELS, null],
      default: null,
    },

    scheduledAt: {
      type: Date,
      default: null,
    },

    scheduledEndAt: {
      type: Date,
      default: null,
    },

    timezone: {
      type: String,
      trim: true,
      default: "",
    },

    meetingUrl: {
      type: String,
      trim: true,
      default: "",
    },

    calendarEventId: {
      type: String,
      trim: true,
      default: "",
    },

    // Used for DB-level double-book protection.
    slotKey: {
      type: String,
      default: null,
    },

    // Public manage/reschedule/cancel access uses a one-way token hash.
    bookingTokenHash: {
      type: String,
      default: "",
      select: false,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    convertedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    convertedBusiness: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

demoRequestSchema.pre("validate", function normalizeDemoPhone() {
  if (this.isNew || this.isModified("phone")) {
    this.phoneE164 = normalizeDemoPhoneToE164(this.phone);
  }
});

/* Default admin list. */
demoRequestSchema.index({ createdAt: -1 });

/* Pipeline filters and operational ordering. */
demoRequestSchema.index({ status: 1, createdAt: -1 });
demoRequestSchema.index({ status: 1, scheduledAt: 1 });

/* Previous requests by email. */
demoRequestSchema.index({ email: 1, createdAt: -1 });

/*
 * Hard protection against two active demo records claiming the exact same slot.
 * slotKey is cleared whenever a request leaves "scheduled".
 */
demoRequestSchema.index(
  { slotKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      slotKey: { $type: "string" },
    },
  },
);

export { DEMO_STATUSES, MONTHLY_CALL_VOLUMES };
export default mongoose.model("DemoRequest", demoRequestSchema);
