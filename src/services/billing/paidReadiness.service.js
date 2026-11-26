import Business from "../../models/business.js";
import User from "../../models/user.js";
import { normalizePhoneToE164 } from "../../voice/voicePhone.service.js";
/** Requires a verified owner and provisioned forwarding service; A2P pending is explicit and permitted. */
export async function requirePaidServiceReady(
  { businessId, ownerId },
  { BusinessModel = Business, UserModel = User } = {},
) {
  const [business, owner] = await Promise.all([
    BusinessModel.findOne({ _id: businessId, owner: ownerId })
      .select("+trackingNumber.providerSid")
      .lean(),
    UserModel.findById(ownerId).lean(),
  ]);
  const forwarding = normalizePhoneToE164(business?.forwardingPhone);
  const ready =
    owner?.emailVerifiedAt &&
    business?.isActive &&
    business.accountLifecycle?.status !== "deleting" &&
    forwarding &&
    business.forwardingPhoneVerifiedAt &&
    normalizePhoneToE164(business.forwardingPhoneVerifiedValue) ===
      forwarding &&
    business.phone &&
    business.trackingNumber?.providerSid &&
    business.trackingNumber.status === "active";
  if (!ready)
    throw Object.assign(
      new Error(
        "Verify your email and business phone, then finish preparing your MeekCall number before payment.",
      ),
      { code: "PAID_SERVICE_NOT_READY", statusCode: 409 },
    );
  return {
    business,
    smsPending: business.messagingCompliance?.smsReady !== true,
  };
}
