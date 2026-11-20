import InterventionReadsController from './intervention/Reads.js';
import InterventionResolutionController from './intervention/Resolution.js';
import InterventionAssignmentController from './intervention/Assignment.js';

class InterventionController {
  static list(...args) { return InterventionReadsController.list(...args); }
  static workflow(...args) { return InterventionReadsController.workflow(...args); }
  static acknowledge(...args) { return InterventionResolutionController.acknowledge(...args); }
  static resolve(...args) { return InterventionResolutionController.resolve(...args); }
  static assign(...args) { return InterventionAssignmentController.assign(...args); }
}

export default InterventionController;

export { INTERVENTION_TYPES, SEVERITY_RANK, compareInterventions, resolveAssignableUserId } from './intervention/helpers.js';
