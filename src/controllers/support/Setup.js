import Joi from 'joi';
import User from '../../models/user.js';
import { getUserId } from './helpers.js';
import { saveSetupSupportTicket } from '../../db/repositories/setupSupportTicketRepository.js';
import { notifyAdminSupportQueue } from '../../services/supportNotification.service.js';

const schema = Joi.object({
  requestId: Joi.string().guid({ version: 'uuidv4' }).required(),
  businessName: Joi.string().trim().min(2).max(100).required(),
  forwardingPhone: Joi.string().trim().pattern(/^[0-9+\-().\s]{7,20}$/).required(),
  message: Joi.string().trim().max(2000).allow('').default(''),
}).unknown(false).required();

export async function createSetupTicket(req, res) {
  const { value, error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: 'Check the business name, phone number, and message before submitting.' });
  try {
    const userId = getUserId(req);
    const user = await User.findById(userId).select('email').lean();
    if (!user) return res.status(401).json({ success: false, message: 'Sign in before requesting setup help.' });
    const result = await saveSetupSupportTicket({
      userId, requestId: value.requestId,
      context: { businessName: value.businessName, forwardingPhone: value.forwardingPhone, replyEmail: user.email },
      message: value.message || 'My forwarding number is already linked to an account. Please help me complete setup.',
    });
    // Also refresh on replay so an earlier interrupted response can recover visibility.
    notifyAdminSupportQueue(result.ticket);
    return res.status(result.created ? 201 : 200).json({ success: true, data: {
      _id: result.ticket._id, replyEmail: result.ticket.setupContext.replyEmail, status: result.ticket.status,
    } });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ success: false,
      message: error.statusCode === 409 ? error.message : 'We could not confirm your support request. Try again; your details are still here.',
    });
  }
}
