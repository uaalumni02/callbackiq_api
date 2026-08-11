const ACTIVITY_TYPE_BY_CHANNEL = {
  phone: "call_initiated",
  email: "email_initiated",
};

const contactError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

class DemoOutreachService {
  static async recordAttempt({
    DemoRequestModel,
    demoId,
    channel,
    actorId = null,
    actorEmail = "",
    now = new Date(),
  }) {
    const demo = await DemoRequestModel.findById(demoId).select(
      "email phone phoneE164",
    );
    if (!demo) return null;

    if (channel === "phone" && !String(demo.phoneE164 || demo.phone || "").trim()) {
      throw contactError(
        "DEMO_OUTREACH_PHONE_MISSING",
        "This demo request does not have a phone number to call.",
      );
    }

    if (channel === "email" && !String(demo.email || "").trim()) {
      throw contactError(
        "DEMO_OUTREACH_EMAIL_MISSING",
        "This demo request does not have an email address.",
      );
    }

    return DemoRequestModel.findByIdAndUpdate(
      demoId,
      {
        $push: {
          outreachActivities: {
            type: ACTIVITY_TYPE_BY_CHANNEL[channel],
            channel,
            actor: actorId || null,
            actorEmail: String(actorEmail || "").trim().toLowerCase(),
            at: now,
          },
        },
        $set: {
          lastOutreachAt: now,
          lastOutreachChannel: channel,
        },
      },
      { new: true, runValidators: true },
    );
  }
}

export { ACTIVITY_TYPE_BY_CHANNEL };
export default DemoOutreachService;
