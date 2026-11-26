import crypto from "node:crypto";
import Business from "../../models/business.js";
import Operations from "../../models/businessOperationsSettings.js";
import {
  dispatchStaffRecipients,
  readStaffDeliveryState,
} from "./recipientPolicy.service.js";
import { sendStaffReviewEmail } from "../../helpers/email/mailer.js";
import { sendSms } from "../twilioSmsService.js";
import { numericSetting } from "../../config/numericSettings.js";
const claimSavedNotificationTest = async (businessId) => {
  const now = new Date();
  const claimed = await Operations.findOneAndUpdate(
    {
      business: businessId,
      $or: [
        { notificationTestAt: null },
        {
          notificationTestAt: {
            $lte: new Date(
              Date.now() -
                numericSetting("PILOT_NOTIFICATION_TEST_COOLDOWN_MS"),
            ),
          },
        },
      ],
    },
    { $set: { notificationTestAt: now } },
    { returnDocument: "after" },
  );
  if (!claimed)
    throw Object.assign(
      new Error("Save your contacts first, then wait a minute between tests."),
      { statusCode: 429 },
    );
};
/** Tests the currently saved ordinary and urgent recipients; throttled server-side, with no draft destinations accepted. */
export async function testSavedStaffNotifications({
  businessId,
  emailSend = sendStaffReviewEmail,
  smsSend = sendSms,
}) {
  const business = await Business.findOne({ _id: businessId, isActive: true });
  if (!business)
    throw Object.assign(new Error("Business not found."), { statusCode: 404 });
  await claimSavedNotificationTest(businessId);
  const key = `test:${crypto.randomUUID()}`;
  const results = {};
  results.email =
    process.env.STAFF_NOTIFICATION_EMAIL_ENABLED === "true"
      ? await dispatchStaffRecipients({
          businessId,
          key,
          channel: "email",
          critical: true,
          send: emailSend,
          payload: (recipient) => ({
            email: recipient.address,
            businessName: business.businessName,
            alertId: "notification-test",
            stage: "test",
          }),
        })
      : { state: "blocked", reason: "EMAIL_DISABLED" };
  results.sms =
    process.env.STAFF_NOTIFICATION_SMS_ENABLED !== "false"
      ? await dispatchStaffRecipients({
          businessId,
          key,
          channel: "sms",
          critical: true,
          send: smsSend,
          payload: (recipient) => ({
            business,
            to: recipient.address,
            body: "MeekCall test notification. Your saved team and urgent contacts are being tested. No customer request needs action.",
            source: "staff_request_notice",
            actorType: "owner",
            usageCategory: "sms",
            metadata: { idempotencyKey: `${key}:${recipient.hash}` },
          }),
        })
      : { state: "blocked", reason: "SMS_DISABLED" };
  return {
    results,
    deliveries: await readStaffDeliveryState(businessId),
    message:
      "Provider acceptance does not prove delivery. Confirm receipt with each contact.",
  };
}
