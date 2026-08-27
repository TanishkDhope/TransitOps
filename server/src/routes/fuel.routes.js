import { Router } from "express";
import { createFuelLog, getFuelLogs, deleteFuelLog } from "../controllers/fuel.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT);

router
  .route("/")
  .get(authorize("cost:read"), getFuelLogs)
  .post(authorize("cost:write"), createFuelLog);

router.route("/:id").delete(authorize("cost:write"), deleteFuelLog);

export default router;
