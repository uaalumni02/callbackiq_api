import AdminActionLog from "../../models/adminActionLog.js";
import { businessId, ok, query, wrap } from "./helpers.js";
import { founderOverview, getSafeCustomerDetails, listCustomers } from "../../services/admin/founderReporting.service.js";

const getFounderDashboard = wrap(async (req, res) => {
  const q = await query.validateAsync(req.query);
  const [founder, customers] = await Promise.all([
    founderOverview(q.days),
    listCustomers(q),
  ]);
  ok(res, { founder, ...customers });
});

const getFounderCustomers = wrap(async (req, res) => {
  ok(res, await listCustomers(await query.validateAsync(req.query)));
});

const getFounderCustomer = wrap(async (req, res) => {
  const key = await businessId(req);
  const data = await getSafeCustomerDetails(key);
  if (!data) {
    res
      .status(404)
      .json({ success: false, message: "Customer business not found" });
    return;
  }
  // Deliberate customer-detail reads remain audited; routine refreshes do not.
  await AdminActionLog.create({
    admin: req.user.userId,
    targetBusiness: key,
    action: "view_customer",
    message: "Admin customer snapshot viewed",
  });
  ok(res, data);
});

export { getFounderDashboard, getFounderCustomers, getFounderCustomer };
