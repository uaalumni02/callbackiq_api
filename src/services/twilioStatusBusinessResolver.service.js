import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import Message from "../models/message.js";

const businessFromRecord = async (record) => {
  const businessId = record?.business?._id || record?.business;
  return businessId ? Business.findById(businessId) : null;
};

export const resolveBusinessForTwilioStatus = async (payload = {}) => {
  const messageSid = String(payload.MessageSid || payload.SmsSid || "").trim();
  if (messageSid) {
    const message = await Message.findOne({ providerMessageId: messageSid })
      .select("business")
      .lean();
    const business = await businessFromRecord(message);
    if (business) return business;
  }
  const callSid = String(payload.CallSid || "").trim();
  if (callSid) {
    const callLog = await CallLog.findOne({ providerCallId: callSid })
      .select("business")
      .lean();
    const business = await businessFromRecord(callLog);
    if (business) return business;
  }
  return null;
};

export default { resolveBusinessForTwilioStatus };
