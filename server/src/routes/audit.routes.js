import { Router } from "express";
import { getAuditLogs, getEntityHistory } from "../controllers/audit.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT, authorize("audit:read"));

router.route("/").get(getAuditLogs);
router.route("/:entity/:entityId").get(getEntityHistory);

export default router;
