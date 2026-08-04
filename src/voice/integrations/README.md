# Existing-job status provider adapters

`voiceExistingJobStatus.service.js` always performs a read-only lookup against the local `Appointment` collection first. It can then enrich that result through a provider-specific adapter registered during application startup.

```js
import { registerVoiceJobStatusProvider } from "../voiceExistingJobStatus.service.js";
import JobberConnectionService from "../../services/jobberConnection.service.js";

registerVoiceJobStatusProvider("jobber", async ({ appointment, businessId }) => {
  const connection = await JobberConnectionService.getConnection({ businessId });
  const visit = await connection.getVisit(
    appointment.externalAppointmentId || appointment.externalCalendarId,
  );

  return {
    verified: true,
    status: visit.status,
    technicianStatus: visit.arrivalStatus || "",
    // Only provide a reply when every statement is verified from provider data.
    reply: visit.arrivalStatus === "en_route"
      ? "The provider shows the technician is en route. I’ll still flag the team if you need a more precise update."
      : "I found the appointment, but I can’t verify a live arrival time. I’ll flag the team for a status callback.",
  };
});
```

## Required rules

- Read-only access only. A status call must never reschedule, cancel, or modify a job.
- Return `verified: false` on missing or ambiguous provider data.
- Never estimate technician location or arrival time.
- Do not expose employee names, private phone numbers, or another customer's information.
- Keep the provider request below `VOICE_JOB_STATUS_TIMEOUT_MS` (default 1.8 seconds).
- Register adapters only after the provider connection and credentials are loaded.

The included registry is production-ready, but no external provider is activated automatically because the repository does not contain deployable Jobber or Housecall Pro credentials.
