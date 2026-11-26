import { restrictProviderBudget } from "../services/budgets/budgetOverride.service.js";
/** Applies an authenticated admin restriction; validation/transaction failures propagate. */
export async function updateProviderBudget(req, res, next) {
  try {
    const data = await restrictProviderBudget({
      admin: req.user,
      businessId: req.params.id,
      limits: req.body.limits,
      reason: req.body.reason,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}
