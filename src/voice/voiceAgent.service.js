import { assessSafety } from './voiceTurn/assessSafety.js';
import { routeSafety } from './voiceTurn/routeSafety.js';
import { routeConversationControl } from './voiceTurn/routeConversationControl.js';
import { captureIntake } from './voiceTurn/captureIntake.js';
import { routeRecovery } from './voiceTurn/routeRecovery.js';
import { routeHumanRequest } from './voiceTurn/routeHumanRequest.js';
import { answerBusinessQuestion } from './voiceTurn/answerBusinessQuestion.js';
import { resolveBookingIntent } from './voiceTurn/resolveBookingIntent.js';
import { executeBooking } from './voiceTurn/executeBooking.js';
import { projectBookingOutcome } from './voiceTurn/projectBookingOutcome.js';
import { confirmBookingOutcome } from './voiceTurn/confirmBookingOutcome.js';
import { dialogMode, preventNonProgressReply, respectCustomerConstraints } from './voiceTurn/context.js';

class VoiceAgentService {
  static async handlePrompt(args) {
    let result = await this.handlePromptInternal(args);
    if (!result?.reply) return result;
    result = preventNonProgressReply({ result, customerMessage: args.customerMessage,
      recentMessages: (args.session?.transcript || []).slice(-10).map(entry => ({
        direction: entry.role === 'customer' ? 'inbound' : 'outbound', body: entry.text })),
      lead: args.session?.lead, conversation: args.session?.conversation,
      mode: dialogMode(process.env) }).result;
    return { ...result, reply: respectCustomerConstraints(result.reply, {
      conversation: args.session?.conversation, customerMessage: args.customerMessage,
    }) };
  }

  static async handlePromptInternal({ session, customerMessage, signal = null, turnId = "" }) {
    const context = { session, customerMessage, signal, turnId };
    for (const stage of [assessSafety, routeSafety, routeConversationControl, captureIntake, routeRecovery, routeHumanRequest, answerBusinessQuestion, resolveBookingIntent, executeBooking, projectBookingOutcome, confirmBookingOutcome]) {
      const result = await stage(context);
      if (result.completed) return result.value;
      Object.assign(context, result.context);
    }
  }
}

export default VoiceAgentService;
