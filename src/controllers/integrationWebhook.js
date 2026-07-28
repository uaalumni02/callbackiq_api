import crypto from "crypto";

import IntegrationConnection from "../models/integrationConnection.js";
import IntegrationWebhookEvent from "../models/integrationWebhookEvent.js";
import { processIntegrationWebhookEvent } from "../workers/integrationWebhook.worker.js";

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const rawBody = (req) =>
  Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

const enqueue = async (data) => {
  try {
    const event = await IntegrationWebhookEvent.create(data);
    setImmediate(() => {
      void processIntegrationWebhookEvent(event._id);
    });
    return { event, duplicate: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const event = await IntegrationWebhookEvent.findOne({
      provider: data.provider,
      eventKey: data.eventKey,
    });
    return { event, duplicate: true };
  }
};

class IntegrationWebhookController {
  static async google(req, res, next) {
    try {
      const channelId = String(req.get("x-goog-channel-id") || "");
      const resourceId = String(req.get("x-goog-resource-id") || "");
      const messageNumber = String(req.get("x-goog-message-number") || "");
      const token = String(req.get("x-goog-channel-token") || "");
      if (!channelId || !resourceId || !messageNumber) {
        return res.status(400).json({ success: false, message: "Missing Google notification headers." });
      }
      const connection = await IntegrationConnection.findOne({
        provider: "google_calendar",
        status: "connected",
        "metadata.googleCalendar.channel.id": channelId,
        "metadata.googleCalendar.channel.resourceId": resourceId,
      });
      const expectedToken = connection?.metadata?.googleCalendar?.channel?.token;
      if (!connection || !expectedToken || !safeEqual(token, expectedToken)) {
        return res.status(401).json({ success: false, message: "Invalid Google notification channel." });
      }
      await enqueue({
        provider: "google_calendar",
        business: connection.business,
        eventKey: `${channelId}:${messageNumber}`,
        topic: String(req.get("x-goog-resource-state") || "change"),
        externalItemId: resourceId,
        payload: {},
        headers: {
          channelId,
          resourceId,
          messageNumber,
          resourceState: req.get("x-goog-resource-state") || "",
        },
      });
      return res.status(204).send();
    } catch (error) {
      return next(error);
    }
  }

  static async jobber(req, res, next) {
    try {
      const body = rawBody(req);
      const provided = String(req.get("x-jobber-hmac-sha256") || "");
      const secret = String(process.env.JOBBER_CLIENT_SECRET || "");
      const calculated = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("base64");
      if (!secret || !provided || !safeEqual(provided, calculated)) {
        return res.status(401).json({ success: false, message: "Invalid Jobber webhook signature." });
      }
      const payload = JSON.parse(body.toString("utf8") || "{}");
      const webhook = payload?.data?.webHookEvent || payload?.webHookEvent || {};
      const eventParts = [
        webhook.accountId,
        webhook.topic,
        webhook.itemId,
        webhook.occurredAt || webhook.occuredAt,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const eventKey = eventParts.length
        ? eventParts.join(":")
        : crypto.createHash("sha256").update(body).digest("hex");
      await enqueue({
        provider: "jobber",
        eventKey,
        topic: String(webhook.topic || ""),
        externalItemId: String(webhook.itemId || ""),
        occurredAt: webhook.occurredAt || webhook.occuredAt
          ? new Date(webhook.occurredAt || webhook.occuredAt)
          : null,
        payload,
        headers: { accountId: webhook.accountId || "" },
      });
      return res.status(202).json({ success: true });
    } catch (error) {
      return next(error);
    }
  }
}

export default IntegrationWebhookController;
