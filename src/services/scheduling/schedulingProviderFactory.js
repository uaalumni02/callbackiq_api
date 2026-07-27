import GoogleCalendarProvider from "../../integrations/scheduling/googleCalendar.provider.js";
import HousecallProProvider from "../../integrations/scheduling/housecallPro.provider.js";
import InternalSchedulingProvider from "../../integrations/scheduling/internalScheduling.provider.js";
import JobberProvider from "../../integrations/scheduling/jobber.provider.js";
import ServiceTitanProvider from "../../integrations/scheduling/serviceTitan.provider.js";

const PROVIDERS = {
  internal: InternalSchedulingProvider,
  google: GoogleCalendarProvider,
  google_calendar: GoogleCalendarProvider,
  jobber: JobberProvider,
  housecall_pro: HousecallProProvider,
  servicetitan: ServiceTitanProvider,
};

class SchedulingProviderFactory {
  static getProvider(business, providerNameOverride = null) {
    const providerName =
      providerNameOverride ||
      business?.features?.calendarProvider ||
      business?.featureSettings?.calendarProvider ||
      "internal";
    const Provider = PROVIDERS[providerName];

    if (!Provider) {
      const error = new Error(`Unsupported scheduling provider: ${providerName}`);
      error.statusCode = 400;
      throw error;
    }

    return new Provider({ business });
  }
}

export default SchedulingProviderFactory;
