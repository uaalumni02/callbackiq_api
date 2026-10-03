import { formatDateKey, zonedDateTimeToUtc } from './timezone.service.js';
import { shiftDate } from './availabilityWindows.service.js';
export function arrivalWindow(startAt, timeZone, policy = {}) {
  if (policy?.appointmentStyle !== 'arrival_window') return {};
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(startAt)).map(p=>[p.type,p.value]));
  const size = [60,120,240].includes(Number(policy.arrivalWindowMinutes)) ? Number(policy.arrivalWindowMinutes) : 120;
  const start = Math.floor((Number(parts.hour)*60+Number(parts.minute))/size)*size;
  const date = formatDateKey(startAt,timeZone);
  const at = minutes=>zonedDateTimeToUtc({dateKey:shiftDate(date,Math.floor(minutes/1440)),timeKey:`${String(Math.floor(minutes%1440/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`,timeZone});
  try { return { arrivalStartAt: at(start), arrivalEndAt: at(start+size) }; }
  catch { return { arrivalStartAt: new Date(startAt), arrivalEndAt: new Date(new Date(startAt).getTime()+size*60000) }; }
}
export function customerAppointmentLabel(slot, timeZone) {
  const zone = timeZone || slot.timezone || 'America/New_York';
  const full = date => new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(date));
  if (!slot.arrivalStartAt || !slot.arrivalEndAt) return full(slot.startAt);
  const end = new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit'}).format(new Date(slot.arrivalEndAt));
  return `${full(slot.arrivalStartAt)}–${end} arrival window`;
}
export function renderAppointmentResponse({ kind, label, service, address, options, requiresApproval = true }, channel = 'sms') {
  const voice = channel === 'voice';
  if (kind === 'address') return 'What’s the address for the visit, including the ZIP code?';
  if (kind === 'offer') return `${options}. ${requiresApproval ? 'These times need team approval. ' : ''}${voice ? 'Which works for you?' : 'Choose an option to submit your request.'}`;
  if (kind === 'review') return `Appointment request: ${label}, for ${service} at ${address}. ${requiresApproval ? 'Business approval required. ' : ''}${voice ? 'Is that correct?' : 'Reply CONFIRM if those details are correct.'}`;
  if (kind === 'submitted') return `Your request for ${label} is pending business approval. It is not confirmed yet.`;
  if (kind === 'confirmed') return `Your appointment is confirmed for ${label}.`;
  if (kind === 'expired') return 'Your request is still open for the team. The earlier time is no longer reserved, so availability needs to be checked again.';
  throw new Error('Unknown scheduling response');
}
