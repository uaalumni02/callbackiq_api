import { providerCapabilities } from './providerCapabilities.js';
import GoogleCalendarProvider from "../../integrations/scheduling/googleCalendar.provider.js";
import HousecallProProvider from "../../integrations/scheduling/housecallPro.provider.js";
import InternalSchedulingProvider from "../../integrations/scheduling/internalScheduling.provider.js";
import JobberProvider from "../../integrations/scheduling/jobber.provider.js";
import ServiceTitanProvider from "../../integrations/scheduling/serviceTitan.provider.js";
import {
  businessCalendarProviderName,
  normalizeCalendarProviderName,
} from "./calendarProviderName.service.js";

const PROVIDERS = {
  internal: InternalSchedulingProvider,
  google_calendar: GoogleCalendarProvider,
  jobber: JobberProvider,
  housecall_pro: HousecallProProvider,
  servicetitan: ServiceTitanProvider,
};

class SchedulingProviderFactory {
  static getProvider(business, providerNameOverride = null) {
    const providerName = providerNameOverride
      ? normalizeCalendarProviderName(providerNameOverride)
      : businessCalendarProviderName(business);
    const Provider = PROVIDERS[providerName];

    if (!Provider) {
      const error = new Error(
        `Unsupported scheduling provider: ${providerName}`,
      );
      error.statusCode = 400;
      error.code = "UNSUPPORTED_SCHEDULING_PROVIDER";
      throw error;
    }

    const provider = new Provider({ business });
    provider.capabilities = providerCapabilities(providerName);
    return provider;
  }
}

export { PROVIDERS };
export default SchedulingProviderFactory;
