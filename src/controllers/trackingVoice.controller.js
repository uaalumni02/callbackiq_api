import CallLog from "../models/callLog.js";
import TrackingNumber from "../models/trackingNumber.js";
import { syncLatestAttribution } from "../services/marketingAttribution.service.js";
import { resolveTwilioNumberContext } from "../services/twilioBusinessResolver.service.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";
import TwilioController from "./twilio.js";

const xml = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const esc = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const send = (res, body) =>
  res.type("text/xml").status(200).send(body);

const empty = () => xml("<Response></Response>");

const canonicalStatus = (providerStatus) =>
  ({
    completed: "answered",
    answered: "answered",
    busy: "busy",
    "no-answer": "no_answer",
    failed: "failed",
    canceled: "failed",
  })[providerStatus] || "missed";

const businessDisposition = (providerStatus) =>
  ({
    completed: "answered_by_business",
    answered: "answered_by_business",
    busy: "busy",
    "no-answer": "no_answer",
    failed: "failed",
    canceled: "failed",
  })[providerStatus] || "missed";

class TrackingVoiceController {
  static async initial(req, res, next) {
    try {
      const from = normalizePhoneToE164(
        req.body.From || req.body.Caller,
      );
      const to = normalizePhoneToE164(
        req.body.To || req.body.Called,
      );
      const callSid = String(req.body.CallSid || "").trim();

      const context = await resolveTwilioNumberContext(to);
      const number = context?.trackingNumber;

      if (
        !context?.business ||
        !number ||
        number.kind !== "marketing"
      ) {
        return next();
      }

      if (number.callHandlingMode === "ai") {
        return next();
      }

      const target = normalizePhoneToE164(
        number.forwardingPhone ||
          context.business.forwardingPhone,
      );

      if (!target) {
        return send(
          res,
          xml(
            "<Response><Say>This tracking number is not configured with a forwarding destination.</Say></Response>",
          ),
        );
      }

      const callLog = await CallLog.findOneAndUpdate(
        {
          business: context.business._id,
          providerCallId: callSid,
        },
        {
          $setOnInsert: {
            business: context.business._id,
            from,
            to,
            direction: "inbound",
            status: "missed",
            disposition: "routing",
            providerStatus: "ringing",
            provider: "twilio",
            providerCallId: callSid,
            marketingSource:
              context.marketingSource?._id || null,
            trackingNumber: number._id,
            attribution: context.attribution || {},
            notes:
              "Marketing call tracked before forwarding to the business.",
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
        },
      );

      await syncLatestAttribution({
        businessId: context.business._id,
        marketingSource: context.marketingSource || null,
        trackingNumber: number,
        calledPhone: to,
        callLogId: callLog?._id || null,
      });

      const action =
        `/api/twilio/tracking-call-complete?parentCallSid=${encodeURIComponent(callSid)}`;

      return send(
        res,
        xml(
          `<Response><Dial answerOnBridge="true" timeout="30" action="${esc(action)}" method="POST"><Number>${esc(target)}</Number></Dial></Response>`,
        ),
      );
    } catch (error) {
      return next(error);
    }
  }

  static async complete(req, res, next) {
    try {
      const parentCallSid = String(
        req.query.parentCallSid ||
          req.body.ParentCallSid ||
          req.body.CallSid ||
          "",
      ).trim();

      const dialStatus = String(
        req.body.DialCallStatus || "",
      )
        .trim()
        .toLowerCase();

      const log = await CallLog.findOne({
        providerCallId: parentCallSid,
      });

      if (!log) {
        return send(res, empty());
      }

      const number = log.trackingNumber
        ? await TrackingNumber.findById(log.trackingNumber)
        : null;

      const answered = ["completed", "answered"].includes(
        dialStatus,
      );

      await CallLog.findByIdAndUpdate(log._id, {
        $set: {
          providerStatus: dialStatus,
          status: canonicalStatus(dialStatus),
          disposition: businessDisposition(dialStatus),
          destinationCallSid: String(
            req.body.DialCallSid || "",
          ),
          ...(answered ? { answeredAt: new Date() } : {}),
        },
      });

      if (answered) {
        return send(res, empty());
      }

      const restoreOriginalCallContext = () => {
        const originalFrom = String(log.from || "").trim();
        const originalTo = String(log.to || "").trim();

        req.body = {
          ...req.body,
          CallSid: parentCallSid,
          ...(originalFrom
            ? {
                From: originalFrom,
                Caller: originalFrom,
              }
            : {}),
          ...(originalTo
            ? {
                To: originalTo,
                Called: originalTo,
              }
            : {}),
        };
      };

      if (
        number?.callHandlingMode === "overflow" &&
        number?.voiceAiEnabled === true
      ) {
        restoreOriginalCallContext();
        req.query.trackingFallback = "ai";
        return next();
      }

      if (number?.smsRecoveryEnabled === true) {
        restoreOriginalCallContext();
        return TwilioController.voiceWebhook(req, res);
      }

      return send(res, empty());
    } catch (error) {
      return next(error);
    }
  }
}

export default TrackingVoiceController;
