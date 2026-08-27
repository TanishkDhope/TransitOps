import { Router } from "express";
import { createExpense, getExpenses, deleteExpense } from "../controllers/expense.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT);

router
  .route("/")
  .get(authorize("cost:read"), getExpenses)
  .post(authorize("cost:write"), createExpense);

router.route("/:id").delete(authorize("cost:write"), deleteExpense);

export default router;
