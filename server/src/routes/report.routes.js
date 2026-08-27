import { Router } from "express";
import {
  getFuelEfficiencyReport,
  getFleetUtilizationReport,
  getOperationalCostReport,
  getVehicleRoiReport,
  getTripProfitabilityReport,
  getLaneProfitabilityReport,
  exportReportCsv,
  exportReportPdf,
} from "../controllers/report.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT, authorize("report:read"));

router.route("/fuel-efficiency").get(getFuelEfficiencyReport);
router.route("/fleet-utilization").get(getFleetUtilizationReport);
router.route("/operational-cost").get(getOperationalCostReport);
router.route("/vehicle-roi").get(getVehicleRoiReport);
// ISSUES #35 — per-trip and per-lane profitability
router.route("/trip-profitability").get(getTripProfitabilityReport);
router.route("/lane-profitability").get(getLaneProfitabilityReport);

router.route("/export.csv").get(exportReportCsv);
router.route("/export.pdf").get(exportReportPdf);

export default router;
