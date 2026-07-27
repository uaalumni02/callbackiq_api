import AutomationJob from "../models/automationJob.js";
import AutomationWorkflow from "../models/automationWorkflow.js";
import getOwnedBusiness from "../services/businessScope.service.js";

class AutomationController {
  static async listWorkflows(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      const workflows = await AutomationWorkflow.find({ business: business._id }).sort({ createdAt: 1 }).lean();
      return res.status(200).json({ success: true, data: workflows });
    } catch (error) { return next(error); }
  }

  static async createWorkflow(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const workflow = await AutomationWorkflow.create({ ...req.body, business: business._id });
      return res.status(201).json({ success: true, data: workflow });
    } catch (error) { return next(error); }
  }

  static async updateWorkflow(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const allowed = [
        "name", "trigger", "enabled", "steps", "maximumAttempts",
        "quietHoursStart", "quietHoursEnd", "minimumIntervalMinutes",
        "allowedDays", "templateApprovalRequired", "templatesApproved",
      ];
      const updates = Object.fromEntries(
        allowed.filter((key) => Object.prototype.hasOwnProperty.call(req.body, key)).map((key) => [key, req.body[key]]),
      );
      const workflow = await AutomationWorkflow.findOneAndUpdate(
        { _id: req.params.id, business: business._id },
        { $set: updates },
        { new: true, runValidators: true },
      );
      if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found." });
      return res.status(200).json({ success: true, data: workflow });
    } catch (error) { return next(error); }
  }

  static async deleteWorkflow(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      const workflow = await AutomationWorkflow.findOneAndDelete({ _id: req.params.id, business: business._id });
      if (!workflow) return res.status(404).json({ success: false, message: "Workflow not found." });
      await AutomationJob.updateMany(
        { workflow: workflow._id, status: { $in: ["scheduled", "processing"] } },
        { $set: { status: "canceled", canceledAt: new Date(), failureReason: "workflow_deleted" } },
      );
      return res.status(200).json({ success: true, message: "Workflow deleted." });
    } catch (error) { return next(error); }
  }

  static async listJobs(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      const filter = { business: business._id };
      if (req.query.status) filter.status = req.query.status;
      if (req.query.conversationId) filter.conversation = req.query.conversationId;
      const jobs = await AutomationJob.find(filter)
        .populate("workflow", "name trigger")
        .populate("lead", "customerName phone status")
        .sort({ executeAt: -1 })
        .limit(Math.min(Number(req.query.limit) || 100, 250))
        .lean();
      return res.status(200).json({ success: true, data: jobs });
    } catch (error) { return next(error); }
  }
}

export default AutomationController;
