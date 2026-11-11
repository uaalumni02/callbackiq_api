import { Db, Response, User, bcrypt, crypto, hashPasswordResetToken, requestPasswordResetSchema, resetPasswordSchema, safeConsole, sendPasswordResetEmail, validate } from './context.js';

export default class AuthPasswordResetController {
static async requestPasswordReset(req, res) {
    try {
      await requestPasswordResetSchema.validateAsync(req.body);

      const { email } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      const user = await Db.findUserByEmail(User, normalizedEmail);

      if (!user) {
        return Response.responseOk(
          res,
          null,
          "If an account exists with that email, a password reset link has been sent",
        );
      }

      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const resetTokenHash = hashPasswordResetToken(resetToken);

      await Db.savePasswordResetToken(
        User,
        user._id,
        resetTokenHash,
        resetTokenExpiresAt,
      );

      try {
        await sendPasswordResetEmail(user.email, resetToken);
      } catch (emailError) {
        safeConsole.error("Password reset email error:", emailError);
        return Response.responseServerError(
          res,
          "Unable to send password reset email",
        );
      }

      return Response.responseOk(
        res,
        null,
        "If an account exists with that email, a password reset link has been sent",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Request password reset error:", error);
      return Response.responseServerError(res);
    }
  }

static async resetPassword(req, res) {
    try {
      await resetPasswordSchema.validateAsync(req.body);

      const { resetToken } = req.params;
      const { password } = req.body;

      if (!resetToken) {
        return Response.responseInvalidInput(res, "Reset token is required");
      }

      if (!validate.isValidPassword(password)) {
        return Response.responseInvalidInput(res, "Invalid password format");
      }

      const resetTokenHash = hashPasswordResetToken(resetToken);
      const user = await Db.findUserByPasswordResetToken(User, resetTokenHash);

      if (!user) {
        return Response.responseInvalidInput(
          res,
          "Invalid or expired reset token",
        );
      }

      const hashedPassword = await bcrypt.hashPassword(password, 10);

      await Db.saveResetPassword(User, user._id, hashedPassword);

      return Response.responseOk(res, null, "Password reset successfully");
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Reset password error:", error);
      return Response.responseServerError(res);
    }
  }
}
