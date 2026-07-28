import { googleApiRequest } from "./googleCalendarConnection.service.js";

export const listGoogleCalendarDirectory = async (businessId) => {
  const response = await googleApiRequest({
    businessId,
    path: "/users/me/calendarList?minAccessRole=freeBusyReader&showHidden=false&maxResults=250",
  });

  return (response.items || []).map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary || calendar.id,
    description: calendar.description || "",
    primary: Boolean(calendar.primary),
    accessRole: calendar.accessRole || "reader",
    timeZone: calendar.timeZone || "",
    selected: calendar.selected !== false,
    writable: ["writer", "owner"].includes(calendar.accessRole),
  }));
};
