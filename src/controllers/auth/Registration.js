import { Business, Db, Response, User, bcrypt, buildAuthToken, captureSignupSecurity, cookieOptions, createInactiveSubscription, crypto, getConsentIp, getTrialEligibility, issueEmailVerification, normalizeBusinessPhone, registerSchema, runRegistrationTransaction, safeConsole, securityGateEnabled, shouldExposeAuthToken, trialEligibilityMessage, validate, verifyTurnstileToken } from './context.js';

export default class AuthRegistrationController {
static async register(req, res) {
    const {
      userName,
      email,
      password,
      businessName,
      businessPhone,
      forwardingPhone,
      businessType = "other",
      smsConsent,
      termsAccepted,
      privacyAccepted,
    } = req.body;

    try {
      await registerSchema.validateAsync(req.body);

      if (securityGateEnabled("REGISTER_TURNSTILE_REQUIRED")) {
        const challenge = await verifyTurnstileToken(
          req.body?.securityChallengeToken || "",
          req,
          { expectedAction: "register" },
        );
        if (!challenge.success) {
          return res.status(403).json({
            success: false,
            code: "REGISTRATION_SECURITY_CHALLENGE_REQUIRED",
            message: "Complete the security check before creating your account.",
          });
        }
      }

      const normalizedEmail = String(email || "")
        .trim()
        .toLowerCase();
      const normalizedUserName =
        String(userName || "").trim() ||
        `cbq${crypto
          .createHash("sha256")
          .update(normalizedEmail)
          .digest("hex")
          .slice(0, 20)}`;

      if (!validate.isValidPassword(password)) {
        return Response.responseInvalidInput(res, "Invalid password format");
      }

      /*
       * Legal acceptance (Terms of Service + Privacy Policy) is required to
       * create an account. This is separate from SMS consent below.
       */
      if (!termsAccepted || !privacyAccepted) {
        return Response.responseInvalidInput(
          res,
          "You must accept the Terms of Service and Privacy Policy",
        );
      }

      const existingUser = await Db.findUserByEmailOrUserName(
        User,
        normalizedUserName,
        normalizedEmail,
      );

      if (existingUser) {
        return Response.responseConflict(
          res,
          "User with this username or email already exists",
        );
      }

      // Older registration clients may still send the owner's existing
      // routing number. The new trial flow collects it during onboarding. It is
      // never the CallBackIQ/Twilio tracking number; tracking-number assignment
      // remains a post-subscription lifecycle.
      const normalizedForwardingPhone = String(
        forwardingPhone || businessPhone || "",
      ).trim();
      const normalizedForwardingLookup =
        normalizeBusinessPhone(normalizedForwardingPhone) ||
        normalizedForwardingPhone;
      if (normalizedForwardingPhone) {
        const existingForwardingPhone = await Business.exists({
          forwardingPhone: {
            $in: [normalizedForwardingPhone, normalizedForwardingLookup],
          },
        });
        if (existingForwardingPhone) {
          return Response.responseConflict(
            res,
            "This forwarding phone is already registered",
          );
        }
      }

      const hashedPassword = await bcrypt.hashPassword(password, 10);

      const now = new Date();

      /*
       * SMS consent is optional and never blocks account creation. Only
       * record consent metadata (timestamp/IP/user agent) when the user
       * actually opted in, so we don't imply consent that wasn't given.
       */
      const smsConsentGiven = Boolean(smsConsent);

      // CALLBACKIQ_REGISTRATION_TRANSACTION_V1
      // CALLBACKIQ_REGISTRATION_TRANSACTION_V1_1
      let savedUser;
      let savedBusiness;
      let savedSubscription;
      let trialEligibility;
      let emailVerificationSent = false;

      const persistRegistration = async (registrationSession = null) => {

      savedUser = await Db.saveUser(User, {
        userName: normalizedUserName,
        email: normalizedEmail,
        password: hashedPassword,
        role: "owner",
        businessName,
        // User.businessPhone is retained for compatibility with existing
        // profile/session code, but represents the existing business line.
        businessPhone: normalizedForwardingPhone,
        businessType,

        smsConsent: smsConsentGiven,
        smsConsentAt: smsConsentGiven ? now : null,
        smsConsentIp: smsConsentGiven ? getConsentIp(req) : "",
        smsConsentUserAgent: smsConsentGiven
          ? req.headers["user-agent"] || ""
          : "",

        termsAccepted: true,
        termsAcceptedAt: now,
        privacyAccepted: true,
        privacyAcceptedAt: now,
      }, { session: registrationSession });

      savedBusiness = await Db.saveBusiness(Business, {
        owner: savedUser._id,
        businessName,
        businessType,
        forwardingPhone: normalizedForwardingPhone,
        email: normalizedEmail,
        isActive: true,
        trackingNumber: {
          provider: "twilio",
          status: "unassigned",
        },
        setupProgress: {
          accountRegistered: true,
          forwardingPhoneConfigured: Boolean(normalizedForwardingPhone),
          updatedAt: now,
        },
        signupSecurity: captureSignupSecurity(req, businessName),
      }, { session: registrationSession });

      /*
       * Registration never consumes the lifetime trial and never provisions a
       * telecom resource. It creates the account, checks eligibility, and
       * waits for signed Stripe completion before access becomes active.
       */
      // Keep Business.isActive true: it represents account suspension, not
      // subscription entitlement. Subscription middleware owns product access.
      savedBusiness.setupProgress.subscriptionActivated = false;
      savedBusiness.setupProgress.updatedAt = new Date();
      await savedBusiness.save({ session: registrationSession });

      savedSubscription = await createInactiveSubscription(savedBusiness._id, { session: registrationSession });
      trialEligibility = await getTrialEligibility({
        business: savedBusiness,
        ownerId: savedUser._id,
        subscription: savedSubscription,
        session: registrationSession,
      });

      };
      await runRegistrationTransaction(persistRegistration);
if (securityGateEnabled("TRIAL_REQUIRE_EMAIL_VERIFICATION")) {
        try {
          const verification = await issueEmailVerification({ user: savedUser });
          emailVerificationSent = verification?.sent === true;
        } catch (verificationError) {
          safeConsole.error("Unable to send signup email verification:", {
            code: verificationError?.code,
            message: verificationError?.message,
          });
        }
      }

      const token = buildAuthToken(savedUser);

      res.cookie("token", token, cookieOptions);

      return Response.responseCreated(
        res,
        {
          ...(shouldExposeAuthToken ? { token } : {}),
          user: {
            _id: savedUser._id,
            userName: savedUser.userName,
            email: savedUser.email,
            role: savedUser.role,
            businessName: savedUser.businessName,
            businessPhone: savedUser.businessPhone,
            businessType: savedUser.businessType,
            smsConsent: savedUser.smsConsent,
            smsConsentAt: savedUser.smsConsentAt,
            termsAccepted: savedUser.termsAccepted,
            termsAcceptedAt: savedUser.termsAcceptedAt,
            privacyAccepted: savedUser.privacyAccepted,
            privacyAcceptedAt: savedUser.privacyAcceptedAt,
          },
          business: savedBusiness,
          subscription: savedSubscription,
          trialGranted: false,
          trialEligible: trialEligibility.eligible,
          trialActivationRequired: trialEligibility.eligible,
          trialDeniedReason: trialEligibility.reason || null,
          emailVerificationRequired: securityGateEnabled(
            "TRIAL_REQUIRE_EMAIL_VERIFICATION",
          ),
          emailVerificationSent,
        },
        trialEligibilityMessage(trialEligibility),
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      if (error.code === 11000) {
        return Response.responseConflict(
          res,
          "Username, email, or business already exists",
        );
      }

      safeConsole.error("Register error:", error);
      return Response.responseServerError(res);
    }
  }
}
