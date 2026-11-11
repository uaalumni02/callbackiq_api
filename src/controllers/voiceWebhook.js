import VoiceWebhookIngressController from './voiceWebhook/Ingress.js';
import VoiceWebhookCompletionController from './voiceWebhook/Completion.js';
import VoiceWebhookStaffScreenController from './voiceWebhook/StaffScreen.js';

class VoiceWebhookController {
  static initial(...args) { return VoiceWebhookIngressController.initial(...args); }
  static overflow(...args) { return VoiceWebhookIngressController.overflow(...args); }
  static complete(...args) { return VoiceWebhookCompletionController.complete(...args); }
  static transferComplete(...args) { return VoiceWebhookCompletionController.transferComplete(...args); }
  static staffScreen(...args) { return VoiceWebhookStaffScreenController.staffScreen(...args); }
  static staffScreenDecision(...args) { return VoiceWebhookStaffScreenController.staffScreenDecision(...args); }
}

export default VoiceWebhookController;
