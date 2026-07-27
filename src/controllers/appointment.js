import getOwnedBusiness from "../services/businessScope.service.js";
import AppointmentService from "../services/scheduling/appointment.service.js";

const getIdempotencyKey = (req) =>
  req.get("Idempotency-Key") || req.body?.idempotencyKey || null;

class AppointmentController {
  static async create(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const appointment = await AppointmentService.create({
        business,
        input: req.body,
        idempotencyKey: getIdempotencyKey(req),
        confirm: req.body.confirm !== false,
      });
      return res.status(appointment.status === "confirmed" ? 201 : 202).json({
        success: true,
        data: appointment,
      });
    } catch (error) {
      return next(error);
    }
  }

  static async list(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      await AppointmentService.releaseExpiredHolds(business._id);
      const appointments = await AppointmentService.list({ businessId: business._id, query: req.query });
      return res.status(200).json({ success: true, data: appointments });
    } catch (error) {
      return next(error);
    }
  }

  static async get(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      const appointment = await AppointmentService.get({
        businessId: business._id,
        appointmentId: req.params.id,
      });
      if (!appointment) {
        return res.status(404).json({ success: false, message: "Appointment not found." });
      }
      return res.status(200).json({ success: true, data: appointment });
    } catch (error) {
      return next(error);
    }
  }

  static async update(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const appointment = await AppointmentService.update({
        businessId: business._id,
        appointmentId: req.params.id,
        changes: req.body,
      });
      return res.status(200).json({ success: true, data: appointment });
    } catch (error) {
      return next(error);
    }
  }

  static async confirm(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const appointment = await AppointmentService.confirm({ business, appointmentId: req.params.id });
      return res.status(200).json({ success: true, data: appointment });
    } catch (error) {
      return next(error);
    }
  }

  static async cancel(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const appointment = await AppointmentService.cancel({
        business,
        appointmentId: req.params.id,
        reason: req.body.reason || "",
      });
      return res.status(200).json({ success: true, data: appointment });
    } catch (error) {
      return next(error);
    }
  }

  static async reschedule(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body.businessId });
      const appointment = await AppointmentService.reschedule({
        business,
        appointmentId: req.params.id,
        input: req.body,
        idempotencyKey: getIdempotencyKey(req),
      });
      return res.status(200).json({ success: true, data: appointment });
    } catch (error) {
      return next(error);
    }
  }
}

export default AppointmentController;
