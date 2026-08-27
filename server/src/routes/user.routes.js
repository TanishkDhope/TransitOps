import { Router } from "express";
import {
  createUser,
  getUsers,
  updateUserRole,
  deleteUser,
  getUnlinkedDrivers,
} from "../controllers/user.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT, authorize("user:write"));

router.route("/unlinked-drivers").get(getUnlinkedDrivers);
router.route("/").post(createUser).get(getUsers);
router.route("/:id").delete(deleteUser);
router.route("/:id/role").patch(updateUserRole);

export default router;
