import LeadCreationController from './lead/Creation.js';
import LeadReadsController from './lead/Reads.js';
import LeadCommandsController from './lead/Commands.js';

class LeadController {
  static createLead(...args) { return LeadCreationController.createLead(...args); }
  static getMyLeads(...args) { return LeadReadsController.getMyLeads(...args); }
  static getMyLeadsOverview(...args) { return LeadReadsController.getMyLeadsOverview(...args); }
  static getLeadById(...args) { return LeadReadsController.getLeadById(...args); }
  static updateLead(...args) { return LeadCommandsController.updateLead(...args); }
  static updateLeadStatus(...args) { return LeadCommandsController.updateLeadStatus(...args); }
  static deleteLead(...args) { return LeadCommandsController.deleteLead(...args); }
}

export default LeadController;
