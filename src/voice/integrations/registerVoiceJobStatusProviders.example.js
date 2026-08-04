import { registerVoiceJobStatusProvider } from "../voiceExistingJobStatus.service.js";

/**
 * Example startup registration. Replace `getProviderVisit` with the repository's
 * authenticated Jobber/Housecall Pro read client after credentials are configured.
 */
export const registerExampleVoiceJobStatusProvider = ({
  providerName,
  getProviderVisit,
}) =>
  registerVoiceJobStatusProvider(providerName, async ({
    appointment,
    businessId,
    externalEventId,
  }) => {
    const visit = await getProviderVisit({
      businessId,
      externalEventId,
      appointment,
    });
    if (!visit?.verified) return { verified: false };

    return {
      verified: true,
      status: visit.status || appointment.status,
      technicianStatus: visit.technicianStatus || "",
      window: visit.window || "",
      reply: visit.reply || "",
    };
  });

export default { registerExampleVoiceJobStatusProvider };
