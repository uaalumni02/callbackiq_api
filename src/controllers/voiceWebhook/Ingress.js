import { TwilioController, VOICE_ROUTE, VoiceAvailabilityService, VoiceOutcomeService, VoicePreflightService, VoiceSessionService, buildOverflowActionPath, determineInitialVoiceRoute, determinePostDialVoiceRoute, emptyTwiml, fallbackSmsResponse, findBusiness, findExistingContext, getScenarioAction, getScenarioName, gracefulVoiceFailure, isTerminal, logOperationalWarning, normalizePostDialFallback, normalizeVoiceSettings, relayOrFailurePolicy, sayTwiml, sendXml, staffAccepted, staffDialResponse } from './context.js';

export default class VoiceWebhookIngressController {
static async initial(req, res) {
    let session = null;
    let settings = null;
    try {
      const fields = {
        from: req.body.From || req.body.Caller || "",
        to: req.body.To || req.body.Called || "",
        providerCallSid: req.body.CallSid || "",
      };
      if (!fields.from || !fields.to || !fields.providerCallSid) {
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, we could not identify this call. Please try again or contact the business directly.",
          ),
        );
      }

      const business = await findBusiness(fields.to);
      if (!business) {
        res.set("X-CallBackIQ-Routing-Error", "TWILIO_NUMBER_NOT_MAPPED");
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, this number is not configured for CallBackIQ voice handling.",
          ),
          404,
        );
      }
      settings = normalizeVoiceSettings(business);
      if (!settings.voiceAiEnabled || settings.answerMode === "disabled") {
        return TwilioController.voiceWebhook(req, res);
      }

      session = await VoiceSessionService.ensureContext({ business, ...fields });
      if (isTerminal(session)) return sendXml(res, emptyTwiml());

      /*
       * Preflight and business-hours resolution are independent. Start the
       * hours lookup immediately so its MongoDB reads overlap the preflight
       * fraud/usage checks instead of adding another serial round trip.
       *
       * Attach the rejection handler before awaiting preflight so an early
       * preflight rejection can never leave an unhandled promise rejection.
       */
      const isOpenPromise = VoiceAvailabilityService.isBusinessOpen(business)
        .catch((error) => {
          logOperationalWarning("voice.business_hours_lookup_failed", {
            businessId: business._id,
            errorCode: error?.code || error?.name || "error",
          });
          return false;
        });

      const preflight = await VoicePreflightService.checkVoicePreflight({
        business,
        callerPhone: session.from,
        providerCallSid: fields.providerCallSid,
        sessionId: session._id,
      });

      if (!preflight.allowed) {
        return fallbackSmsResponse({
          res, session, failureReason: preflight.reason,
          message: "I preserved your call for the team instead of starting the automated assistant.",
        });
      }

      const isOpen = await isOpenPromise;
      const scenario = getScenarioName(isOpen);
      const action = getScenarioAction({ settings, isOpen });
      const route = determineInitialVoiceRoute({ settings, isOpen });

      if (route === VOICE_ROUTE.LEGACY) {
        return TwilioController.voiceWebhook(req, res);
      }
      if (route === VOICE_ROUTE.DIAL_STAFF) {
        return staffDialResponse({
          res,
          session,
          phone: settings.transferPhone,
          timeoutSeconds: settings.overflowRingSeconds,
          actionPath: buildOverflowActionPath({ action, scenario }),
          purpose: "initialStaff",
        });
      }
      if (route === VOICE_ROUTE.RELAY) {
        return relayOrFailurePolicy({
          res,
          business,
          settings,
          session,
          unavailableReason: `The ${scenario} policy selected voice AI, but the secure relay was unavailable.`,
        });
      }
      return fallbackSmsResponse({
        res,
        session,
        failureReason: `The ${scenario} policy selected callback-first SMS recovery.`,
        message:
          "Thanks for calling. I preserved your call for the team. Please contact the business directly if you need further assistance.",
      });
    } catch (error) {
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "initial_voice_routing",
      });
    }
  }

static async overflow(req, res) {
    let session = null;
    let settings = null;
    try {
      const context = await findExistingContext(req);
      session = context.session;
      if (!session || !context.business || isTerminal(session)) {
        return sendXml(res, emptyTwiml());
      }
      settings = normalizeVoiceSettings(context.business);
      const dialStatus = String(req.body?.DialCallStatus || "").toLowerCase();
      const accepted = staffAccepted(session, "initialStaff");
      const route =
        accepted && ["answered", "completed"].includes(dialStatus)
          ? VOICE_ROUTE.COMPLETE
          : determinePostDialVoiceRoute({
              dialStatus: accepted ? dialStatus : "no-answer",
              fallback: normalizePostDialFallback(req.query.fallback),
            });

      if (route === VOICE_ROUTE.COMPLETE) {
        await VoiceOutcomeService.commitVoiceOutcome({
          sessionId: session._id, outcome: "transfer_accepted", status: "completed",
          metadata: { dialStatus, routedToStaff: true, staffScreenAccepted: true, scenario: String(req.query.scenario || "") },
        });
        return sendXml(res, emptyTwiml());
      }
      if (route === VOICE_ROUTE.FALLBACK_SMS) {
        return fallbackSmsResponse({
          res,
          session,
          failureReason: `Staff did not accept the screened call (${dialStatus || "unknown"}).`,
        });
      }
      return relayOrFailurePolicy({
        res,
        business: context.business,
        settings,
        session,
        unavailableReason: `Staff did not accept the call (${dialStatus || "unknown"}) and voice AI was unavailable.`,
      });
    } catch (error) {
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "voice_overflow_callback",
      });
    }
  }
}
