import { validateServiceArea } from "../../../services/scheduling/appointmentPolicy.service.js";

export const validateServiceAreaTool = ({ businessId, postalCode }) =>
  validateServiceArea({ businessId, postalCode });

export default validateServiceAreaTool;
