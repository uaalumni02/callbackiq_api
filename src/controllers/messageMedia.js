import { allowedMediaUrl, loadProviderMedia, mediaResponsePolicy } from '../services/security/providerMedia.js';
import mongoose from "mongoose";
import Db from "../db/db.js";
import Business from "../models/business.js";
import Message from "../models/message.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const getBusinessForOwner = async (ownerId) =>
  typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);

class MessageMediaController {
  static async getMedia(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { messageId, mediaIndex } = req.params;
      if (!ownerId) return res.status(401).json({ success: false, message: "Not authenticated" });
      if (!mongoose.isValidObjectId(messageId)) {
        return res.status(400).json({ success: false, message: "Invalid message ID" });
      }
      const index = Number.parseInt(mediaIndex, 10);
      if (!Number.isInteger(index) || index < 0 || index > 9) {
        return res.status(400).json({ success: false, message: "Invalid media index" });
      }

      const business = await getBusinessForOwner(ownerId);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const message = await Message.findOne({ _id: messageId, business: business._id });
      const media = message?.media?.[index];
      if (!media || !allowedMediaUrl(media.providerUrl)) {
        return res.status(404).json({ success: false, message: "Media not found" });
      }

      const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
      const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
      if (!accountSid || !authToken) {
        return res.status(503).json({ success: false, message: "Twilio media access is not configured." });
      }
      const { buffer, contentType } = await loadProviderMedia({ url: media.providerUrl,
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        businessId: business._id, req, res });
      const responsePolicy = mediaResponsePolicy(contentType);
      res.setHeader('Content-Type', responsePolicy.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Disposition", `${responsePolicy.disposition}; filename="callbackiq-media-${index}"`);
      return res.status(200).send(buffer);
    } catch (error) {
      logOperationalError("message.media_proxy.failed", error, {
        messageId: req.params?.messageId,
        mediaIndex: req.params?.mediaIndex,
        ownerId: req.user?.userId,
      });
      if (res.destroyed) return undefined;
      if (error.statusCode === 429) res.setHeader('Retry-After', '2');
      return res.status(error.statusCode || 502).json({ success: false, message: "Unable to load message media." });
    }
  }
}

export default MessageMediaController;
