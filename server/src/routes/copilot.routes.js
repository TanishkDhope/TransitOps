import { Router } from "express";
import { askCopilot, askCopilotStream, getCopilotStatus } from "../controllers/copilot.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT);

router.route("/ask").post(authorize("copilot:query"), askCopilot);
router.route("/ask/stream").post(authorize("copilot:query"), askCopilotStream);
router.route("/status").get(authorize("copilot:query"), getCopilotStatus);

export default router;
