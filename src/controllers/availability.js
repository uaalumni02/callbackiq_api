import AvailabilityException from '../models/availabilityException.js';
import { formatDateKey } from '../services/scheduling/timezone.service.js';
import { runStaffSchedulingRequest } from '../services/scheduling/staffSchedulingException.service.js';
import getOwnedBusiness from "../services/businessScope.service.js";
import AvailabilityService from "../services/scheduling/availability.service.js";

class AvailabilityController {
  static async fullToday(req, res, next) {
    try {
      if (req.method !== 'GET' && typeof req.body.blocked !== 'boolean') throw Object.assign(new Error('Choose whether to block new appointments.'), {statusCode:400});
      const business=await getOwnedBusiness({user:req.user});
      const date=formatDateKey(new Date(),business.timezone||'America/New_York');
      const key={business:business._id,date,type:'fully_booked',name:'Dashboard booking block',appliesTo:'appointments'};
      if (req.method === 'GET') {
        const blocked = Boolean(await AvailabilityException.exists({ ...key, active: true }));
        return res.json({success:true,date,blocked});
      }
      if (req.body.blocked) await AvailabilityException.findOneAndUpdate(key,{$set:{active:true,allDay:true,windows:[],capacity:0}},{upsert:true,new:true,runValidators:true});
      else await AvailabilityException.updateMany(key,{$set:{active:false}});
      res.json({success:true,date,blocked:req.body.blocked});
    } catch(error) {next(error);}
  }

  static async list(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const { serviceOfferingId, startDate, endDate, postalCode } = req.query;

      if (!serviceOfferingId || !startDate || !endDate) {
        return res.status(400).json({
          success: false,
          message: "serviceOfferingId, startDate, and endDate are required.",
        });
      }

      const result = await runStaffSchedulingRequest({ business, userId: req.user?.userId, preview: true,
        input: { serviceOfferingId, ...(req.query.shortNoticeReason ? { schedulingException: { allowShortNotice: true, reason: req.query.shortNoticeReason } } : {}) } }, () => AvailabilityService.getAvailability({
        business,
        serviceOfferingId,
        startDate,
        endDate,
        postalCode,
      }));

      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return next(error);
    }
  }
}

export default AvailabilityController;
