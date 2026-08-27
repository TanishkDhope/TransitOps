import { Router } from "express";
import {
  createVehicle,
  getVehicles,
  getVehicleById,
  updateVehicle,
  retireVehicle,
  reinstateVehicle,
  extractVehicleDocuments,
} from "../controllers/vehicle.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";
import { upload, handleUploadErrors } from "../middlewares/upload.middleware.js";

const router = Router();

// ISSUES #2 — authentication was commented out on this router, exposing the
// entire fleet registry (and its mutations) to unauthenticated callers.
router.use(verifyJWT);

router
  .route("/")
  .get(authorize("vehicle:read"), getVehicles)
  .post(authorize("vehicle:write"), createVehicle);

router
  .route("/extract-documents")
  .post(
    authorize("vehicle:write"),
    handleUploadErrors(upload.array("documents", 5)),
    extractVehicleDocuments
  );

router
  .route("/:id")
  .get(authorize("vehicle:read"), getVehicleById)
  .patch(authorize("vehicle:write"), updateVehicle)
  .delete(authorize("vehicle:retire"), retireVehicle);

router.route("/:id/reinstate").patch(authorize("vehicle:retire"), reinstateVehicle);

export default router;
