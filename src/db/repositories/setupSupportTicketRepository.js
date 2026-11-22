import { createHash } from 'node:crypto';
import SupportTicket from '../../models/supportTicket.js';

// Account-scoped setup requests never infer business ownership from a phone number.
// A deterministic primary key makes concurrent submissions and uncertain retries safe
// without requiring a new production index.
export async function saveSetupSupportTicket({ userId, requestId, context, message }) {
  const id = createHash('sha256').update(`setup-support:${userId}:${requestId}`).digest('hex').slice(0, 24);
  const filter = { _id: id, user: userId, source: 'setup' };
  try {
    const ticket = await SupportTicket.create({
      _id: id, user: userId, source: 'setup', setupContext: context,
      subject: 'Forwarding number setup help', category: 'account', priority: 'high', message,
    });
    return { ticket, created: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const ticket = await SupportTicket.findOne(filter);
    if (!ticket) throw error;
    if (ticket.message !== message || ticket.setupContext.businessName !== context.businessName ||
        ticket.setupContext.forwardingPhone !== context.forwardingPhone) {
      throw Object.assign(new Error('These details changed. Submit a new support request.'), { statusCode: 409 });
    }
    return { ticket, created: false };
  }
}
