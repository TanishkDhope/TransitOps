import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import env from "./src/config/env.js";
import { ApiError, ERROR_CODES } from "./src/utils/ApiError.js";

import authRouter from "./src/routes/auth.routes.js";
import vehicleRouter from "./src/routes/vehicle.routes.js";
import driverRouter from "./src/routes/driver.routes.js";
import tripRouter from "./src/routes/trip.routes.js";
import maintenanceRouter from "./src/routes/maintenance.routes.js";
import fuelRouter from "./src/routes/fuel.routes.js";
import expenseRouter from "./src/routes/expense.routes.js";
import dashboardRouter from "./src/routes/dashboard.routes.js";
import reportRouter from "./src/routes/report.routes.js";
import userRouter from "./src/routes/user.routes.js";
import customerRouter from "./src/routes/customer.routes.js";
import auditRouter from "./src/routes/audit.routes.js";
import notificationRouter from "./src/routes/notification.routes.js";
import meRouter from "./src/routes/me.routes.js";

const app = express();

/**
 * Vite auto-increments its port (5173 → 5174 → …) whenever the previous dev
 * server is still bound, which happens easily during iterative development.
 * A hardcoded CORS_ORIGIN then silently blocks the browser with no server-side
 * log to explain why. In development, allow any localhost/127.0.0.1 origin
 * regardless of port; in production, only the configured origin(s).
 */
function resolveCorsOrigin(origin, callback) {
  if (!origin) return callback(null, true); // same-origin / curl / server-to-server

  if (env.corsOrigins.includes(origin)) return callback(null, true);

  if (!env.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return callback(null, true);
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS`));
}

// ISSUES #23 — CORS first, so preflight requests short-circuit before body parsing.
app.use(
  cors({
    origin: resolveCorsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

// ISSUES #22 — body parsers registered exactly once, so the 16kb limit is effective.
// (Previously an unlimited pair was registered first and silently won.)
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use(cookieParser());
app.use(express.static("public"));

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/me", meRouter);
app.use("/api/v1/vehicles", vehicleRouter);
app.use("/api/v1/drivers", driverRouter);
app.use("/api/v1/trips", tripRouter);
app.use("/api/v1/customers", customerRouter);
app.use("/api/v1/maintenance", maintenanceRouter);
app.use("/api/v1/fuel-logs", fuelRouter);
app.use("/api/v1/expenses", expenseRouter);
app.use("/api/v1/dashboard", dashboardRouter);
app.use("/api/v1/reports", reportRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/audit", auditRouter);
// ISSUES #4 — this router existed but was never mounted.
app.use("/api/v1/notifications", notificationRouter);

app.get("/", (req, res) => {
  res.json({ success: true, message: "TransitOps API", version: "v1" });
});

app.get("/api/v1/health", async (req, res) => {
  res.json({ success: true, status: "ok", uptime: process.uptime() });
});

// Unknown API route → a real 404 rather than the SPA fallback or a hanging request.
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    code: ERROR_CODES.NOT_FOUND,
    message: `Route ${req.method} ${req.originalUrl} does not exist`,
  });
});

// ---------- Global error handler ----------
// Produces the uniform { success, code, message } envelope the client's toast
// layer consumes, and maps Prisma's error codes to messages a user can act on.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    if (err.status >= 500) console.error(err);
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // ---- Prisma known request errors ----
  if (err.code === "P2002") {
    const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : err.meta?.target;
    return res.status(409).json({
      success: false,
      code: ERROR_CODES.DUPLICATE,
      message: target
        ? `A record with this ${target} already exists`
        : "A record with these details already exists",
      details: { fields: Array.isArray(err.meta?.target) ? err.meta.target : undefined },
    });
  }

  if (err.code === "P2003") {
    return res.status(409).json({
      success: false,
      code: ERROR_CODES.IN_USE,
      message: "This record is referenced by other data and cannot be removed.",
    });
  }

  if (err.code === "P2025") {
    return res.status(404).json({
      success: false,
      code: ERROR_CODES.NOT_FOUND,
      message: "The requested record no longer exists.",
    });
  }

  // ---- Malformed JSON body ----
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({
      success: false,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "The request body is not valid JSON.",
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      message: "The request body is too large.",
    });
  }

  console.error(err);
  return res.status(err.status || 500).json({
    success: false,
    code: ERROR_CODES.INTERNAL,
    // Never leak internals in production — the log above has the detail.
    message: env.isProduction
      ? "Something went wrong on our end. Please try again."
      : err.message || "Internal Server Error",
  });
});

export default app;
