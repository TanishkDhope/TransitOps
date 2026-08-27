import { Router } from "express";
import {
  getAvailableVehicles,
  getAvailableDrivers,
  getSchedule,
  createTrip,
  getTrips,
  getTripById,
  updateTrip,
  dispatchTrip,
  completeTrip,
  cancelTrip,
} from "../controllers/trip.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

// ISSUES #2 — authentication was commented out here too.
router.use(verifyJWT);

router.route("/available-vehicles").get(authorize("trip:write"), getAvailableVehicles);
router.route("/available-drivers").get(authorize("trip:write"), getAvailableDrivers);
router.route("/schedule").get(authorize("trip:read"), getSchedule);

router
  .route("/")
  .get(authorize("trip:read"), getTrips)
  .post(authorize("trip:write"), createTrip);

router
  .route("/:id")
  .get(authorize("trip:read"), getTripById)
  .patch(authorize("trip:write"), updateTrip);

router.route("/:id/dispatch").post(authorize("trip:dispatch"), dispatchTrip);
router.route("/:id/complete").post(authorize("trip:dispatch"), completeTrip);
router.route("/:id/cancel").post(authorize("trip:dispatch"), cancelTrip);

export default router;
