import { resolveTwilioNumberContext } from "../services/twilioBusinessResolver.service.js";
import { readProviderEntitlement } from "../services/providerEntitlement.service.js";
const unavailable =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This automated service is currently unavailable. Please contact the business directly. For an emergency, hang up and call 911.</Say><Hangup/></Response>';
/** Stops inactive call ingress before relay, forwarding or SMS; lookup outages also fail closed. */
export default async function voiceProviderEntitlement(req, res, next) {
  try {
    const context = await resolveTwilioNumberContext(
      req.body.To || req.body.Called,
    );
    if (!context?.business) return next();
    if ((await readProviderEntitlement(context.business._id)).allowed)
      return next();
  } catch {
    /* An uncertain entitlement never authorizes a provider action. */
  }
  return res.status(200).type("text/xml").send(unavailable);
}
