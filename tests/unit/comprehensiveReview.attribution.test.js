import mongoose from 'mongoose';
import Lead from '../../src/models/lead.js';
import CallLog from '../../src/models/callLog.js';
import Appointment from '../../src/models/appointment.js';
import MarketingSource from '../../src/models/marketingSource.js';
import Conversion from '../../src/models/conversionEvent.js';
import { resolveAppointmentAttribution } from '../../src/services/scheduling/appointment.service.js';
import RevenueRecovery from '../../src/services/analytics/revenueRecovery.service.js';
const business = new mongoose.Types.ObjectId(), lead = new mongoose.Types.ObjectId();
const A = new mongoose.Types.ObjectId(), B = new mongoose.Types.ObjectId(), appointmentId = new mongoose.Types.ObjectId();
const query = value => ({ select: () => query(value), sort: () => query(value), lean: async () => value });
afterEach(() => jest.restoreAllMocks());
test('repeat caller A then B keeps acquisition A even with explicit latest-call metadata B', async () => {
 jest.spyOn(Lead, 'findOne').mockReturnValue(query({ firstMarketingSource: A, firstAttribution: { sourceName: 'Source A' } }));
 const call = jest.spyOn(CallLog, 'findOne').mockReturnValue(query({ marketingSource: B }));
 expect(await resolveAppointmentAttribution({ businessId: business, input: { lead, marketingSource: B } })).toMatchObject({ marketingSource: A, attribution: { sourceName: 'Source A' } });
 expect(call).not.toHaveBeenCalled(); expect(Lead.findOne).toHaveBeenCalledWith({ _id: lead, business });
});
test('legacy lead uses earliest attributed call, retaining the call interaction sources', async () => {
 jest.spyOn(Lead, 'findOne').mockReturnValue(query(null));
 const sorted = jest.fn(() => query({ marketingSource: A }));
 jest.spyOn(CallLog, 'findOne').mockReturnValue({ sort: sorted });
 expect(await resolveAppointmentAttribution({ businessId: business, input: { lead } })).toMatchObject({ marketingSource: A });
 expect(sorted).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
});
test('current completed revenue 725 wins over immutable event snapshot 300 without double credit', async () => {
 jest.spyOn(MarketingSource, 'find').mockReturnValue(query([{ _id: A, name: 'Source A' }]));
 jest.spyOn(CallLog, 'aggregate').mockResolvedValue([]);
 jest.spyOn(Appointment, 'aggregate').mockResolvedValueOnce([{ _id: A, bookedJobs: 1, actualBookedRevenue: 725, totalBookedAttributableValue: 725 }])
  .mockResolvedValueOnce([{ _id: appointmentId, status: 'completed', actualRevenue: 725 }]);
 const event = { appointment: appointmentId, marketingSource: A, attribution: {} };
 jest.spyOn(Conversion, 'find').mockReturnValueOnce(query([event, event]))
  .mockReturnValueOnce(query([{ appointment: appointmentId, actualRevenue: 300 }]));
 const rows = await RevenueRecovery.marketingSources({ businessId: business });
 const row = rows.find(item => item.sourceId === String(A));
 expect(row).toMatchObject({ bookedJobs: 1, recoveredBookedJobs: 1, actualBookedRevenue: 725, actualRecoveredRevenue: 725 });
});
