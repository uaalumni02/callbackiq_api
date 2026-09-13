import { assertServiceRequestEligible } from '../../../services/serviceEligibility/serviceEligibility.service.js';
import AvailabilityService from "../../../services/scheduling/availability.service.js";
import { filterAutomatedSlots } from '../../../services/scheduling/automatedSchedulingPolicy.service.js';

export const getAvailabilityTool = async options => {
  await assertServiceRequestEligible({ businessId: options.business?._id, leadId: options.leadId, conversationId: options.conversationId, serviceOfferingId: options.serviceOfferingId, request: options.serviceQuery });
  const result = await AvailabilityService.getAvailability(options);
  return { ...result, slots: filterAutomatedSlots(result.slots) };
};

export default getAvailabilityTool;
