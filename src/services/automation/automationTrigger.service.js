import AutomationJob from "../../models/automationJob.js";
import AutomationWorkflow from "../../models/automationWorkflow.js";

class AutomationTriggerService {
  static async schedule({
    businessId,
    trigger,
    leadId = null,
    conversationId = null,
    appointmentId = null,
    triggerInstanceId,
    occurredAt = new Date(),
  }) {
    const occurred = new Date(occurredAt);
    if (Number.isNaN(occurred.getTime())) {
      const error = new Error("occurredAt must be a valid date.");
      error.statusCode = 400;
      throw error;
    }

    const workflows = await AutomationWorkflow.find({
      business: businessId,
      trigger,
      enabled: true,
      $or: [
        { templateApprovalRequired: false },
        { templatesApproved: true },
      ],
    }).lean();
    const jobs = [];

    for (const workflow of workflows) {
      let cumulativeDelay = 0;
      const steps = workflow.steps.slice(0, workflow.maximumAttempts || workflow.steps.length);

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const step = steps[stepIndex];
        cumulativeDelay += Number(step.delayMinutes || 0);
        const idempotencyKey = [
          trigger,
          triggerInstanceId || conversationId || leadId || appointmentId,
          workflow._id,
          stepIndex,
        ].join(":");

        try {
          const job = await AutomationJob.create({
            business: businessId,
            workflow: workflow._id,
            lead: leadId,
            conversation: conversationId,
            appointment: appointmentId,
            stepIndex,
            action: step.action,
            template: step.template,
            status: "scheduled",
            executeAt: new Date(occurred.getTime() + cumulativeDelay * 60_000),
            attemptNumber: 1,
            idempotencyKey,
          });
          jobs.push(job);
        } catch (error) {
          if (error?.code !== 11000) throw error;
        }
      }
    }

    return jobs;
  }
}

export default AutomationTriggerService;
