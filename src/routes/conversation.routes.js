import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import ConversationController from "../controllers/conversation.js";

const router = express.Router();

const ADMIN_ROLES = new Set([
  "admin",
  "administrator",
  "superadmin",
  "super_admin",
]);

const getAuthenticatedRole = (req) =>
  String(req.user?.role || req.user?.userRole || req.user?.accountType || "")
    .trim()
    .toLowerCase();

// Business owners keep the existing subscription requirement. Admins can
// perform management actions without needing a customer subscription record.
const checkSubscriptionUnlessAdmin = (req, res, next) => {
  if (
    req.user?.isAdmin === true ||
    ADMIN_ROLES.has(getAuthenticatedRole(req))
  ) {
    return next();
  }

  return checkSubscription(req, res, next);
};

router
  .route("/")
  .post(checkAuth, checkSubscription, ConversationController.createConversation)
  .get(checkAuth, checkSubscription, ConversationController.getMyConversations);

router.post(
  "/:id/archive",
  checkAuth,
  checkSubscriptionUnlessAdmin,
  ConversationController.archiveConversation,
);

router.post(
  "/:id/restore",
  checkAuth,
  checkSubscriptionUnlessAdmin,
  ConversationController.restoreConversation,
);

router
  .route("/:id")
  .get(checkAuth, checkSubscription, ConversationController.getConversationById)
  .patch(
    checkAuth,
    checkSubscription,
    ConversationController.updateConversation,
  )
  .delete(
    checkAuth,
    checkSubscriptionUnlessAdmin,
    ConversationController.deleteConversation,
  );

export default router;
