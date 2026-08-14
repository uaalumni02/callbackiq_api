const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const cleanError = (error) => {
  const code = error?.code || error?.status || error?.statusCode || "A2P_LINK_FAILED";
  const message = error?.message || "Unable to link the tracking number to messaging registration.";
  return `${code}: ${message}`.slice(0, 1000);
};

const getMessagingServiceSid = (business) =>
  String(business?.messagingCompliance?.messagingServiceSid || "").trim();

const listCampaigns = async (client, messagingServiceSid) =>
  client.messaging.v1.services(messagingServiceSid).usAppToPerson.list({ limit: 20 });

const listSenders = async (client, messagingServiceSid) =>
  client.messaging.v1.services(messagingServiceSid).phoneNumbers.list({ limit: 1000 });

const senderMatches = (sender, phoneNumberSid) =>
  String(sender?.phoneNumberSid || sender?.sid || "") === String(phoneNumberSid || "");

export const buildUnconfiguredA2pState = () => ({
  a2pStatus: "unconfigured",
  campaignStatus: "",
  smsReady: false,
  senderAttached: false,
  senderAttachedAt: null,
  lastCheckedAt: new Date(),
  lastError: "",
});

export const attachPhoneNumberToBusinessMessagingRegistration = async ({
  client,
  business,
  phoneNumberSid,
}) => {
  const messagingServiceSid = getMessagingServiceSid(business);
  const now = new Date();

  if (!messagingServiceSid) return buildUnconfiguredA2pState();
  if (!client || !phoneNumberSid) {
    return {
      a2pStatus: "failed",
      campaignStatus: "",
      smsReady: false,
      senderAttached: false,
      senderAttachedAt: null,
      lastCheckedAt: now,
      lastError: "A2P_LINK_INPUT_REQUIRED: Twilio client and phone number SID are required.",
    };
  }

  try {
    // Attach first. New CallBackIQ customers can have a Messaging Service before
    // their Brand/Campaign reaches approval; the sender must still be retained in
    // the correct per-business Sender Pool while compliance progresses.
    const senders = await listSenders(client, messagingServiceSid);
    let senderAttached = senders.some((sender) => senderMatches(sender, phoneNumberSid));

    let campaigns = [];
    try {
      campaigns = await listCampaigns(client, messagingServiceSid);
    } catch (_error) {
      campaigns = [];
    }

    const campaign =
      campaigns.find((item) => normalizeStatus(item?.campaignStatus) === "VERIFIED") ||
      campaigns[0] ||
      null;
    const campaignStatus = normalizeStatus(campaign?.campaignStatus);
    const useCase = normalizeStatus(campaign?.usAppToPersonUsecase);

    if (!senderAttached && useCase === "SOLE_PROPRIETOR" && senders.length > 0) {
      return {
        a2pStatus: "failed",
        campaignStatus,
        smsReady: false,
        senderAttached: false,
        senderAttachedAt: null,
        lastCheckedAt: now,
        lastError:
          "SOLE_PROPRIETOR_NUMBER_LIMIT: This Campaign supports one 10DLC sender. Keep the existing sender or migrate this business to Standard/Low-Volume Standard before rotating numbers.",
      };
    }

    if (!senderAttached) {
      await client.messaging.v1
        .services(messagingServiceSid)
        .phoneNumbers.create({ phoneNumberSid });
      senderAttached = true;
    }

    // Sender-pool membership is not proof of carrier registration. smsReady is
    // turned on only by the Twilio number-registration successful event.
    return {
      a2pStatus: campaignStatus === "VERIFIED" ? "pending" : "pending",
      campaignStatus,
      smsReady: false,
      senderAttached,
      senderAttachedAt: senderAttached ? now : null,
      lastCheckedAt: now,
      lastError: "",
    };
  } catch (error) {
    return {
      a2pStatus: "failed",
      campaignStatus: "",
      smsReady: false,
      senderAttached: false,
      senderAttachedAt: null,
      lastCheckedAt: now,
      lastError: cleanError(error),
    };
  }
};

export const toMessagingComplianceUpdate = (state = {}) => ({
  "messagingCompliance.a2pStatus": state.a2pStatus || "unconfigured",
  "messagingCompliance.campaignStatus": state.campaignStatus || "",
  "messagingCompliance.smsReady": Boolean(state.smsReady),
  "messagingCompliance.senderAttached": Boolean(state.senderAttached),
  "messagingCompliance.senderAttachedAt": state.senderAttachedAt || null,
  "messagingCompliance.lastCheckedAt": state.lastCheckedAt || new Date(),
  "messagingCompliance.lastError": String(state.lastError || "").slice(0, 1000),
});
