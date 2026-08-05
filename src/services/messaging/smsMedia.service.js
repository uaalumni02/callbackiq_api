const MAX_TWILIO_MEDIA = 10;

const safeMediaUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const allowed =
      url.protocol === "https:" &&
      (url.hostname === "api.twilio.com" ||
        url.hostname.endsWith(".twilio.com") ||
        url.hostname.endsWith(".twiliocdn.com"));
    return allowed ? url.toString() : "";
  } catch {
    return "";
  }
};

export const parseInboundTwilioMedia = (body = {}) => {
  const requested = Number.parseInt(String(body.NumMedia || "0"), 10);
  const count = Number.isFinite(requested)
    ? Math.min(MAX_TWILIO_MEDIA, Math.max(0, requested))
    : 0;
  const media = [];

  for (let index = 0; index < count; index += 1) {
    const providerUrl = safeMediaUrl(body[`MediaUrl${index}`]);
    if (!providerUrl) continue;
    media.push({
      providerUrl,
      contentType: String(body[`MediaContentType${index}`] || "application/octet-stream")
        .trim()
        .toLowerCase(),
      providerIndex: index,
      storageStatus: "provider",
    });
  }

  return media;
};

export const buildMediaOnlyAcknowledgement = (media = []) => {
  const hasImage = media.some((item) =>
    String(item?.contentType || "").startsWith("image/"),
  );
  return hasImage
    ? "Got the photo — what service do you need help with?"
    : "Got the attachment — what service do you need help with?";
};

export const isImageMedia = (media) =>
  String(media?.contentType || "").toLowerCase().startsWith("image/");

export default {
  parseInboundTwilioMedia,
  buildMediaOnlyAcknowledgement,
  isImageMedia,
};
