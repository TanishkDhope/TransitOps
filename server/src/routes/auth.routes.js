import { Router } from "express";
import {
  registerUser,
  loginUser,
  logoutUser,
  getCurrentUser,
  refreshAccessToken,
  changePassword,
} from "../controllers/auth.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

// Public
router.route("/register").post(registerUser); // gated by ALLOW_SELF_REGISTRATION (ISSUES #7)
router.route("/login").post(loginUser);
// ISSUES #15 — POST, not GET: a GET has no body, so the old req.body fallback was dead code.
router.route("/refresh-token").post(refreshAccessToken);

// Authenticated
router.route("/logout").post(verifyJWT, logoutUser);
router.route("/current-user").get(verifyJWT, getCurrentUser);
router.route("/change-password").post(verifyJWT, changePassword);

export default router;
