import Business from '../../models/business.js';
import Message from '../../models/message.js';
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
export async function resolveSmsRecords(job) {
  const [business, inboundMessage, conversation, lead] = await Promise.all([
    Business.findById(job.business),
    Message.findOne({ _id: job.inboundMessage, business: job.business, conversation: job.conversation }),
    Conversation.findOne({ _id: job.conversation, business: job.business }),
    Lead.findOne({ _id: job.lead, business: job.business }),
  ]);

  if (!business || !inboundMessage || !conversation || !lead) {
    const error = new Error("SMS processing job references missing records");
    error.code = "SMS_JOB_RECORD_MISSING";
    throw error;
  }
  if (conversation.lead && String(conversation.lead) !== String(lead._id)) {
    throw Object.assign(new Error('SMS job references a different request'), { code: 'SMS_JOB_RECORD_MISMATCH' });
  }
  return { job, business, inboundMessage, conversation, lead };
}
