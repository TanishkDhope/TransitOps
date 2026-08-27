import { Router } from "express";
import {
  createDriver,
  getDrivers,
  getDriverById,
  updateDriver,
  suspendDriver,
  updateDriverStatus,
  deleteDriver,
  restoreDriver,
  recalculateSafetyScores,
  extractDriverLicense,
} from "../controllers/driver.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";
import { upload, handleUploadErrors } from "../middlewares/upload.middleware.js";

const router = Router();

// ISSUES #2 — this router previously exposed every driver's name, email, phone
// number and licence number with no authentication at all.
router.use(verifyJWT);

router
  .route("/")
  .get(authorize("driver:read"), getDrivers)
  .post(authorize("driver:write"), createDriver);

router
  .route("/extract-license")
  .post(
    authorize("driver:write"),
    handleUploadErrors(
      upload.fields([
        { name: "frontImage", maxCount: 1 },
        { name: "backImage", maxCount: 1 },
      ])
    ),
    extractDriverLicense
  );

router
  .route("/recalculate-scores")
  .post(authorize("driver:write"), recalculateSafetyScores);

router
  .route("/:id")
  .get(authorize("driver:read"), getDriverById)
  .patch(authorize("driver:write"), updateDriver)
  .delete(authorize("driver:archive"), deleteDriver);

router.route("/:id/suspend").patch(authorize("driver:suspend"), suspendDriver);
// ISSUES #10 — reinstatement and OFF_DUTY were previously unreachable.
router.route("/:id/status").patch(authorize("driver:suspend"), updateDriverStatus);
router.route("/:id/restore").patch(authorize("driver:archive"), restoreDriver);

export default router;
