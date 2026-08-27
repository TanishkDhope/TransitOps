import { Router } from "express";
import {
  createCustomer,
  getCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  quoteTrip,
} from "../controllers/customer.controller.js";
import { verifyJWT, authorize } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyJWT);

router.route("/quote").get(authorize("customer:read"), quoteTrip);

router
  .route("/")
  .get(authorize("customer:read"), getCustomers)
  .post(authorize("customer:write"), createCustomer);

router
  .route("/:id")
  .get(authorize("customer:read"), getCustomerById)
  .patch(authorize("customer:write"), updateCustomer)
  .delete(authorize("customer:write"), deleteCustomer);

export default router;
