import {
  checkForwardingPhoneVerification,
  getTrialIdentityVerificationStatus,
  resendEmailVerification,
  startForwardingPhoneVerification,
  verifyEmailToken,
} from "../services/trialIdentityVerification.service.js";

const sendError = (res, error) =>
  res.status(error?.statusCode || 500).json({
    success: false,
    code: error?.code || "VERIFICATION_FAILED",
    message: error?.message || "Verification could not be completed.",
  });

class VerificationController {
  static async status(req, res) {
    try {
      const data = await getTrialIdentityVerificationStatus(req.user?.userId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return sendError(res, error);
    }
  }

  static async resendEmail(req, res) {
    try {
      const data = await resendEmailVerification(req.user?.userId);
      return res.status(200).json({
        success: true,
        data,
        message: data?.alreadyVerified
          ? "Email is already verified."
          : "Verification email sent.",
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  static async verifyEmail(req, res) {
    try {
      const data = await verifyEmailToken(req.body?.token);
      return res.status(200).json({
        success: true,
        data,
        message: "Email verified successfully.",
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  static async startPhone(req, res) {
    try {
      const data = await startForwardingPhoneVerification({
        ownerId: req.user?.userId,
        channel: req.body?.channel,
      });
      return res.status(200).json({
        success: true,
        data,
        message:
          data.channel === "call"
            ? "Verification call started."
            : "Verification code sent.",
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  static async checkPhone(req, res) {
    try {
      const data = await checkForwardingPhoneVerification({
        ownerId: req.user?.userId,
        code: req.body?.code,
      });
      return res.status(200).json({
        success: true,
        data,
        message: "Business phone verified successfully.",
      });
    } catch (error) {
      return sendError(res, error);
    }
  }
}

export default VerificationController;
