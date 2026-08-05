import {
  buildMediaOnlyAcknowledgement,
  parseInboundTwilioMedia,
} from "../../src/services/messaging/smsMedia.service.js";

test("parses media-only Twilio MMS payloads", () => {
  const media = parseInboundTwilioMedia({
    NumMedia: "2",
    MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/AC/Messages/SM/Media/ME1",
    MediaContentType0: "image/jpeg",
    MediaUrl1: "https://media.twiliocdn.com/file.pdf",
    MediaContentType1: "application/pdf",
  });
  expect(media).toHaveLength(2);
  expect(media[0]).toMatchObject({ contentType: "image/jpeg", providerIndex: 0 });
  expect(buildMediaOnlyAcknowledgement(media)).toMatch(/Got the photo/i);
});
