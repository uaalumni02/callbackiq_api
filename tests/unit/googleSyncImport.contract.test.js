import { loadGoogleCalendarSyncService } from "../../src/controllers/integration/helpers.js";

test('the real Google sync lazy loader resolves its operational interface', async () => {
  const service = await loadGoogleCalendarSyncService();
  for (const operation of ['syncGoogleCalendar', 'startGoogleCalendarWatch', 'stopGoogleCalendarWatch']) {
    expect(service[operation]).toEqual(expect.any(Function));
  }
});
