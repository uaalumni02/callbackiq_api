const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const cleanError = (error) => {
  const code = error?.code || error?.status || error?.statusCode || "A2P_LINK_FAILED";
  const message = error?.message || "Unable to link the tracking number to the existing messaging registration.";
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
    const campaigns = await listCampaigns(client, messagingServiceSid);
    const preferredCampaign =
      campaigns.find((campaign) => normalizeStatus(campaign?.campaignStatus) === "VERIFIED") ||
      campaigns[0];

    if (!preferredCampaign) {
      return {
        a2pStatus: "failed",
        campaignStatus: "",
        smsReady: false,
        senderAttached: false,
        senderAttachedAt: null,
        lastCheckedAt: now,
        lastError:
          "A2P_CAMPAIGN_NOT_FOUND: The configured Messaging Service does not have an A2P 10DLC Campaign.",
      };
    }

    const campaignStatus = normalizeStatus(preferredCampaign.campaignStatus);
    const usecase = normalizeStatus(preferredCampaign.usAppToPersonUsecase);
    const senders = await listSenders(client, messagingServiceSid);
    let senderAttached = senders.some((sender) => senderMatches(sender, phoneNumberSid));

    if (!senderAttached && usecase === "SOLE_PROPRIETOR" && senders.length > 0) {
      return {
        a2pStatus: "failed",
        campaignStatus,
        smsReady: false,
        senderAttached: false,
        senderAttachedAt: null,
        lastCheckedAt: now,
        lastError:
          "SOLE_PROPRIETOR_NUMBER_LIMIT: This A2P Campaign supports only one sender number. Use a Standard/Low-Volume Standard registration before rotating or adding another 10DLC sender.",
      };
    }

    if (!senderAttached) {
      await client.messaging.v1
        .services(messagingServiceSid)
        .phoneNumbers.create({ phoneNumberSid });
      senderAttached = true;
    }

    const verifiedCampaign = campaignStatus === "VERIFIED";
    return {
      a2pStatus: verifiedCampaign ? "registered" : "pending",
      campaignStatus,
      smsReady: Boolean(senderAttached && verifiedCampaign),
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
