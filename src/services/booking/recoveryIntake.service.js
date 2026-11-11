import { captureRequestFacts } from './recoveryIntake/captureRequestFacts.js';
import { classifyRequestContext } from './recoveryIntake/classifyRequestContext.js';
import { captureServicePreference } from './recoveryIntake/captureServicePreference.js';
import { assessTriageEvidence } from './recoveryIntake/assessTriageEvidence.js';
import { createIntakeActions } from './recoveryIntake/createIntakeActions.js';
import { assessQualification } from './recoveryIntake/assessQualification.js';
import { verifyCoverage } from './recoveryIntake/verifyCoverage.js';
import { routeScheduling } from './recoveryIntake/routeScheduling.js';
import { resolvePreference } from './recoveryIntake/resolvePreference.js';
import { verifyRequestedAvailability } from './recoveryIntake/verifyRequestedAvailability.js';
import { submitStaffReview } from './recoveryIntake/submitStaffReview.js';
export { confirmationTimingReply } from './recoveryIntake/context.js';

export const handleRecoveryIntake = async ({ business, lead, conversation, customerMessage, channel = 'sms', session = null, turnId = '', semanticAssessment = null, recentMessages = [], reviewOnly = false, now = new Date() }) => {
    const context = { business, lead, conversation, customerMessage, channel, session, turnId, semanticAssessment, recentMessages, reviewOnly, now };
    for (const stage of [captureRequestFacts, classifyRequestContext, captureServicePreference, assessTriageEvidence, createIntakeActions, assessQualification, verifyCoverage, routeScheduling, resolvePreference, verifyRequestedAvailability, submitStaffReview]) {
      const result = await stage(context);
      if (result.completed) return result.value;
      Object.assign(context, result.context);
    }
  };
