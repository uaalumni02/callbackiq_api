import mongoose from "mongoose";
import VoiceSession from "../../src/models/voiceSession.js";

describe("VoiceSession model", () => {
  test("defines tenant-scoped provider idempotency", () => {
    const indexes = VoiceSession.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { business: 1, providerCallSid: 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });

  test("does not index empty provider session identifiers", () => {
    const providerIndex = VoiceSession.schema
      .indexes()
      .find(([fields]) => fields.providerSessionId === 1);
    expect(providerIndex?.[1]?.partialFilterExpression).toEqual({
      providerSessionId: { $gt: "" },
    });
  });

  test("accepts the Phase 9 lifecycle fields", () => {
    const session = new VoiceSession({
      business: new mongoose.Types.ObjectId(),
      providerCallSid: "CA123",
      status: "active",
      transcript: [{ role: "customer", text: "I need plumbing help." }],
      confirmationSmsStatus: "pending",
    });
    const error = session.validateSync();
    expect(error).toBeUndefined();
    expect(VoiceSession.schema.path("confirmationSmsStatus")).toBeDefined();
    expect(VoiceSession.schema.path("confirmationSmsSentAt")).toBeDefined();
  });
});
