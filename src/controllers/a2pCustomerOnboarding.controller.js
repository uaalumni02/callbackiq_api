import Business from "../models/business.js";
import {
  getRegistrationWithSecrets,
  retrySoleProprietorOtp,
  startA2pCustomerRegistration,
  syncA2pCustomerRegistration,
  toPublicA2pRegistration,
} from "../services/a2pCustomerOnboarding.service.js";

const ownerIdFrom = (req) => req.user?.userId || req.user?._id || req.user?.id;

const findBusiness = async (req) => {
  const ownerId = ownerIdFrom(req);
  if (!ownerId) return null;
  return Business.findOne({ owner: ownerId });
};

const respondError = (res, error) => {
  const message = error?.message || "Unable to complete messaging registration.";
  const status = /required|valid|select|unsupported|already has|must use|cannot be changed/i.test(message)
    ? 400
    : 502;
  return res.status(status).json({ success: false, message });
};

export const getA2pRegistration = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const registration = await getRegistrationWithSecrets(business._id);
    return res.status(200).json({ success: true, data: toPublicA2pRegistration(registration) });
  } catch (error) {
    return respondError(res, error);
  }
};

export const submitA2pRegistration = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const data = await startA2pCustomerRegistration({ businessId: business._id, input: req.body || {} });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

export const syncA2pRegistration = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const data = await syncA2pCustomerRegistration({ businessId: business._id });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

export const retryA2pOtp = async (req, res) => {
  try {
    const business = await findBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    const data = await retrySoleProprietorOtp({ businessId: business._id });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};
