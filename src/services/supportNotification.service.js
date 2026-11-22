import SocketService from './socket.service.js';
import logger from '../config/logger.js';

export function notifyAdminSupportQueue(ticket) {
  // The saved queue and dashboard polling remain authoritative if delivery fails.
  try {
    SocketService.emitToAdmins('admin:dashboard:refresh', {
      reason: 'support_ticket_created', ticketId: String(ticket._id),
    });
  } catch {
    logger.warn('support.admin_refresh_failed', { ticketId: String(ticket._id) });
  }
}
