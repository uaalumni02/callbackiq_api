import AvailabilityService from "../../../services/scheduling/availability.service.js";
import { filterAutomatedSlots } from '../../../services/scheduling/automatedSchedulingPolicy.service.js';

export const getAvailabilityTool = async options => {
  const result = await AvailabilityService.getAvailability(options);
  return { ...result, slots: filterAutomatedSlots(result.slots) };
};

export default getAvailabilityTool;
