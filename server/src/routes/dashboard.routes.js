import { Router } from "express";
import { getKpis, getAlerts } from "../controllers/dashboard.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT);

router.route("/kpis").get(authorize("dashboard:read"), getKpis);
router.route("/alerts").get(authorize("dashboard:read"), getAlerts);

export default router;
