import { getOwnedBusiness } from "../../services/businessScope.service.js";
import { getVoiceSettingsContract, validateVoiceSettingsDraft } from "../../services/voiceSettingsContract.service.js";
import { listVoiceSettingsVersions, rollbackVoiceSettingsVersion } from "../../services/voiceSettingsVersion.service.js";
import { serialize } from "./helpers.js";

export default class VoiceSettingsVersionsController {
static async schema(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const current = serialize(business);
      return res.status(200).json({
        success: true,
        data: getVoiceSettingsContract({ currentVoiceName: current.voiceName }),
      });
    } catch (error) {
      return next(error);
    }
  }

static async validateDraft(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId,
      });
      const current = serialize(business);
      const draft = req.body?.settings || req.body || {};
      const result = validateVoiceSettingsDraft(draft, {
        currentVoiceName: current.voiceName,
      });
      return res.status(result.valid ? 200 : 400).json({
        success: result.valid,
        data: result,
        message: result.valid
          ? "Voice settings are valid."
          : result.errors.map((item) => item.message).join(" "),
      });
    } catch (error) {
      return next(error);
    }
  }

static async versions(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      const versions = await listVoiceSettingsVersions({ businessId: business._id });
      return res.status(200).json({ success: true, data: versions });
    } catch (error) { return next(error); }
  }

static async rollback(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body?.businessId });
      const result = await rollbackVoiceSettingsVersion({
        business,
        version: req.params.version,
        publishedBy: req.user?.userId || req.user?._id || null,
        reason: req.body?.reason || "Voice settings rollback.",
      });
      return res.status(200).json({ success: true, data: serialize(result.business), publication: { version: result.published.version, rolledBackFromVersion: result.target.version } });
    } catch (error) { return next(error); }
  }

static async get(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      return res.status(200).json({ success: true, data: serialize(business) });
    } catch (error) {
      return next(error);
    }
  }
}
