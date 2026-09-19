import Business from "../models/business.js";
import { readOwnerSettings, saveOwnerSettings } from "../services/ownerSettings.service.js";
const failure = (res, err) => {
  if (err.isJoi || err.name === "ValidationError" || err.name === "CastError") return res.status(400).json({ success: false, message: err.message });
  if (err.code === 11000) return res.status(409).json({ success: false, message: "An item with that name already exists. Review your changes and try again." });
  if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
  return res.status(503).json({ success: false, message: "Settings could not be saved or loaded. Your edits have been kept. Please try again." });
};
export const getOwnerSettings = async (req, res) => {
  try {
    const business = await Business.findOne({ owner: req.user.userId });
    if (!business) return res.status(404).json({ success: false, message: "Business not found." });
    return res.json({ success: true, data: await readOwnerSettings(business) });
  } catch (err) { return failure(res, err); }
};
export const putOwnerSettings = async (req, res) => {
  try {
    const data = await saveOwnerSettings({ ownerId: req.user.userId, section: req.params.section, payload: req.body.values, revision: req.body.revision });
    return res.json({ success: true, data });
  } catch (err) { return failure(res, err); }
};
