import { Router } from "express";
import {
  triggerExpiryCheck,
  getNotificationLogs,
  getNotificationStatus,
} from "../controllers/notification.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

// ISSUES #4 — this router is now actually mounted in app.js.
router.use(verifyJWT, authorize("notification:trigger"));

router.route("/check-expiries").post(triggerExpiryCheck);
router.route("/logs").get(getNotificationLogs);
router.route("/status").get(getNotificationStatus);

export default router;
