import AvailabilityService from "../../../services/scheduling/availability.service.js";

export const getAvailabilityTool = (options) => AvailabilityService.getAvailability(options);

export default getAvailabilityTool;
