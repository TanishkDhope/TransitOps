import { Router } from "express";
import {
  getMyProfile,
  getMyCurrentTrip,
  getMyTrips,
  completeMyTrip,
  logMyFuel,
  logMyExpense,
} from "../controllers/me.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

// ISSUES #37 — driver self-service. Every handler resolves the Driver record from
// the signed-in user and refuses to act on anyone else's trip, so no extra role
// guard is needed beyond authentication.
router.use(verifyJWT);

router.route("/profile").get(getMyProfile);
router.route("/current-trip").get(getMyCurrentTrip);
router.route("/trips").get(getMyTrips);
router.route("/trips/:id/complete").post(completeMyTrip);
router.route("/fuel-logs").post(logMyFuel);
router.route("/expenses").post(logMyExpense);

export default router;
