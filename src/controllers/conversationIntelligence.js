import ConversationIntelligenceAnalysisController from './conversationIntelligence/Analysis.js';
import ConversationIntelligenceReadsController from './conversationIntelligence/Reads.js';
import ConversationIntelligenceFeedbackController from './conversationIntelligence/Feedback.js';

class ConversationIntelligenceController {
  static analyzeConversation(...args) { return ConversationIntelligenceAnalysisController.analyzeConversation(...args); }
  static getMyConversationIntelligence(...args) { return ConversationIntelligenceReadsController.getMyConversationIntelligence(...args); }
  static getConversationIntelligence(...args) { return ConversationIntelligenceReadsController.getConversationIntelligence(...args); }
  static getOpportunities(...args) { return ConversationIntelligenceReadsController.getOpportunities(...args); }
  static getDashboard(...args) { return ConversationIntelligenceReadsController.getDashboard(...args); }
  static updateFeedback(...args) { return ConversationIntelligenceFeedbackController.updateFeedback(...args); }
  static updateRecommendedAction(...args) { return ConversationIntelligenceFeedbackController.updateRecommendedAction(...args); }
  static deleteConversationIntelligence(...args) { return ConversationIntelligenceFeedbackController.deleteConversationIntelligence(...args); }
}

export default ConversationIntelligenceController;
