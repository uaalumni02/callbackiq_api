import ConversationAccessController from './conversation/Access.js';
import ConversationRecordsController from './conversation/Records.js';
import ConversationLifecycleController from './conversation/Lifecycle.js';

class ConversationController {
  static getAuthorizedConversation(...args) { return ConversationAccessController.getAuthorizedConversation(...args); }
  static createConversation(...args) { return ConversationRecordsController.createConversation(...args); }
  static getMyConversations(...args) { return ConversationRecordsController.getMyConversations(...args); }
  static getConversationById(...args) { return ConversationRecordsController.getConversationById(...args); }
  static updateConversation(...args) { return ConversationRecordsController.updateConversation(...args); }
  static archiveConversation(...args) { return ConversationLifecycleController.archiveConversation(...args); }
  static restoreConversation(...args) { return ConversationLifecycleController.restoreConversation(...args); }
  static deleteConversation(...args) { return ConversationLifecycleController.deleteConversation(...args); }
}

export default ConversationController;
