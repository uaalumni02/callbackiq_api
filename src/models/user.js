import mongoose from "mongoose";

const { Schema } = mongoose;

import * as validate from "../helpers/model/user.js";

const UserSchema = new Schema(
  {
    userName: {
      type: String,
      required: [true, "Please enter a username"],
      trim: true,
      unique: true,
      validate: [validate.isValidUserName, "Please enter a valid username"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      unique: true,
      validate: [validate.isValidEmail, "Please enter a valid email address"],
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      select: false,
    },

    role: {
      type: String,
      enum: ["owner", "admin", "member"],
      default: "owner",
      required: true,
      validate: [validate.isValidRole, "Role must be owner, admin, or member"],
    },

    businessName: {
      type: String,
      required: [true, "Business name is required"],
      trim: true,
      maxlength: 100,
    },

    businessPhone: {
      type: String,
      default: "",
      trim: true,
    },

    businessType: {
      type: String,
      enum: [
        "hvac",
        "plumbing",
        "roofing",
        "electrical",
        "restoration",
        "other",
      ],
      default: "other",
    },

    smsConsent: {
      type: Boolean,
      default: false,
    },

    smsConsentAt: {
      type: Date,
      default: null,
    },

    smsConsentIp: {
      type: String,
      default: "",
      trim: true,
    },

    smsConsentUserAgent: {
      type: String,
      default: "",
      trim: true,
    },

    termsAccepted: {
      type: Boolean,
      default: false,
      required: true,
    },

    termsAcceptedAt: {
      type: Date,
      default: null,
    },

    privacyAccepted: {
      type: Boolean,
      default: false,
      required: true,
    },

    privacyAcceptedAt: {
      type: Date,
      default: null,
    },

    emailVerifiedAt: {
      type: Date,
      default: null,
    },

    emailVerificationTokenHash: {
      type: String,
      default: null,
      select: false,
    },

    emailVerificationExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },

    resetToken: {
      type: String,
      default: null,
      select: false,
    },

    resetTokenExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },

    /*
     * Login protection
     *
     * failedLoginAttempts:
     * Number of failures inside the current 15-minute observation window.
     *
     * loginBlockedUntil:
     * Date before which login attempts remain temporarily blocked.
     *
     * loginLockoutLevel:
     * Number of recent temporary blocks. Determines progressive delay.
     *
     * securityChallengeRequired:
     * Requires CAPTCHA after sustained suspicious activity.
     */
    failedLoginAttempts: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },

    lastFailedLoginAt: {
      type: Date,
      default: null,
      select: false,
    },

    loginBlockedUntil: {
      type: Date,
      default: null,
      select: false,
    },

    loginLockoutLevel: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },

    lastLoginLockoutAt: {
      type: Date,
      default: null,
      select: false,
    },

    securityChallengeRequired: {
      type: Boolean,
      default: false,
      select: false,
    },

    securityChallengeRequiredAt: {
      type: Date,
      default: null,
      select: false,
    },

    lastSuccessfulLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports password-reset token lookup and expiration validation.
 * Documents with resetToken set to null are excluded from the index.
 */
UserSchema.index(
  {
    resetToken: 1,
    resetTokenExpiresAt: 1,
  },
  {
    partialFilterExpression: {
      resetToken: {
        $type: "string",
      },
    },
  },
);

UserSchema.methods.toJSON = function () {
  const obj = this.toObject();

  delete obj.password;
  delete obj.resetToken;
  delete obj.resetTokenExpiresAt;
  delete obj.emailVerificationTokenHash;
  delete obj.emailVerificationExpiresAt;
  delete obj.failedLoginAttempts;
  delete obj.lastFailedLoginAt;
  delete obj.loginBlockedUntil;
  delete obj.loginLockoutLevel;
  delete obj.lastLoginLockoutAt;
  delete obj.securityChallengeRequired;
  delete obj.securityChallengeRequiredAt;

  return obj;
};

const User = mongoose.models.User || mongoose.model("User", UserSchema);

export default User;
