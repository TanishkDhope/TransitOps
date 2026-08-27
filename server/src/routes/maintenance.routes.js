import { Router } from "express";
import {
  createMaintenanceLog,
  getMaintenanceLogs,
  getMaintenanceLogById,
  updateMaintenanceLog,
  closeMaintenanceLog,
  getServiceDueVehicles,
} from "../controllers/maintenance.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT);

router.route("/service-due").get(authorize("maintenance:read"), getServiceDueVehicles);

router
  .route("/")
  .get(authorize("maintenance:read"), getMaintenanceLogs)
  .post(authorize("maintenance:write"), createMaintenanceLog);

router
  .route("/:id")
  .get(authorize("maintenance:read"), getMaintenanceLogById)
  .patch(authorize("maintenance:write"), updateMaintenanceLog);

router.route("/:id/close").patch(authorize("maintenance:write"), closeMaintenanceLog);

export default router;
