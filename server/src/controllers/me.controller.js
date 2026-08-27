// ISSUES #37 — Driver self-service.
//
// Drivers were the subject of the system but never users of it: the person
// actually running the trip could not see their assignment, complete it, or log
// a fuel fill from the pump. Every data point had to be re-entered by an office
// user afterwards — exactly the manual-entry problem the AI extraction feature
// was built to solve, left unsolved at the most important point of capture.

import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { badRequest, notFound, forbidden, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, toEnum, toDate, isMissing } from "../utils/validators.js";
import { refreshSafetyScore } from "../services/safety.service.js";
import { auditOp, writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

const DRIVER_EXPENSE_TYPES = ["TOLL", "PARKING", "FINE", "OTHER"];

/** Resolves the Driver record behind the signed-in user. */
async function requireDriverProfile(req) {
  const driver = await prisma.driver.findUnique({ where: { userId: req.user.id } });

  if (!driver) {
    throw forbidden(
      "Your account is not linked to a driver profile. Please contact your fleet manager."
    );
  }
  if (driver.status === "ARCHIVED") {
    throw forbidden("Your driver profile is archived. Please contact your fleet manager.");
  }

  return driver;
}

/** The driver's own profile, licence status and headline stats. */
export const getMyProfile = asyncHandler(async (req, res) => {
  const driver = await requireDriverProfile(req);

  const [completedTrips, upcomingTrips] = await Promise.all([
    prisma.trip.count({ where: { driverId: driver.id, status: "COMPLETED" } }),
    prisma.trip.count({ where: { driverId: driver.id, status: { in: ["DRAFT", "DISPATCHED"] } } }),
  ]);

  const daysToExpiry = Math.ceil(
    (new Date(driver.licenseExpiry) - new Date()) / (1000 * 60 * 60 * 24)
  );

  return res.status(200).json({
    success: true,
    data: {
      ...driver,
      stats: { completedTrips, upcomingTrips },
      licence: {
        daysToExpiry,
        expired: daysToExpiry < 0,
        expiringSoon: daysToExpiry >= 0 && daysToExpiry <= 30,
      },
    },
  });
});

/** The trip the driver is currently running, if any. */
export const getMyCurrentTrip = asyncHandler(async (req, res) => {
  const driver = await requireDriverProfile(req);

  const trip = await prisma.trip.findFirst({
    where: { driverId: driver.id, status: "DISPATCHED" },
    orderBy: { dispatchedAt: "desc" },
    include: {
      vehicle: { select: { id: true, registrationNo: true, name: true, odometer: true, maxLoadKg: true } },
      customer: { select: { id: true, name: true, phone: true } },
      fuelLogs: { orderBy: { loggedAt: "desc" } },
      expenses: { orderBy: { incurredAt: "desc" } },
    },
  });

  return res.status(200).json({ success: true, data: trip });
});

/** Everything assigned to this driver — upcoming and historical. */
export const getMyTrips = asyncHandler(async (req, res) => {
  const driver = await requireDriverProfile(req);
  const { status } = req.query;

  const trips = await prisma.trip.findMany({
    where: { driverId: driver.id, ...(status ? { status } : {}) },
    orderBy: { plannedStart: "desc" },
    take: 100,
    include: {
      vehicle: { select: { id: true, registrationNo: true, name: true } },
      customer: { select: { id: true, name: true } },
    },
  });

  return res.status(200).json({ success: true, data: trips });
});

/** Lets the driver close out their own trip from the road. */
export const completeMyTrip = asyncHandler(async (req, res) => {
  const driver = await requireDriverProfile(req);

  if (isMissing(req.body?.endOdometer)) {
    throw badRequest("The final odometer reading is required.", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["endOdometer"],
    });
  }

  const endOdometer = toFiniteNumber(req.body.endOdometer, "endOdometer", { min: 0 });
  const fuelConsumedL = isMissing(req.body.fuelConsumedL)
    ? null
    : toFiniteNumber(req.body.fuelConsumedL, "fuelConsumedL", { min: 0 });

  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true },
  });

  if (!trip) throw notFound("Trip");

  // A driver may only ever act on their own trip.
  if (trip.driverId !== driver.id) {
    throw forbidden("This trip is not assigned to you.");
  }
  if (trip.status !== "DISPATCHED") {
    throw badRequest(
      `This trip is ${trip.status.toLowerCase()} and cannot be completed.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (endOdometer < trip.vehicle.odometer) {
    throw badRequest(
      `The reading must be at least ${trip.vehicle.odometer.toLocaleString("en-IN")} km — the vehicle's current odometer.`,
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["endOdometer"] }
    );
  }

  const actualDistance = endOdometer - (trip.startOdometer ?? trip.vehicle.odometer);

  const [updated] = await prisma.$transaction([
    prisma.trip.update({
      where: { id: trip.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        endOdometer,
        ...(fuelConsumedL != null ? { fuelConsumedL } : {}),
      },
      include: { vehicle: true, customer: true },
    }),
    prisma.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "AVAILABLE", odometer: endOdometer },
    }),
    prisma.driver.update({ where: { id: driver.id }, data: { status: "AVAILABLE" } }),
    auditOp({
      actor: req.user,
      entity: "Trip",
      entityId: trip.id,
      action: AUDIT_ACTIONS.COMPLETE,
      summary: `Driver ${driver.name} completed ${trip.source} → ${trip.destination} (${actualDistance.toLocaleString("en-IN")} km)`,
      before: { status: "DISPATCHED" },
      after: { status: "COMPLETED", endOdometer },
    }),
  ]);

  await refreshSafetyScore(driver.id);

  return res.status(200).json({
    success: true,
    message: `Trip completed — ${actualDistance.toLocaleString("en-IN")} km recorded. Well done!`,
    data: updated,
  });
});

/** Fuel logged at the pump, against the driver's own active trip. */
export const logMyFuel = asyncHandler(async (req, res) => {
  const driver = await requireDriverProfile(req);
  requireFields(req.body, ["tripId"]);

  if (isMissing(req.body.liters) || isMissing(req.body.cost)) {
    throw badRequest("Litres and cost are both required.", ERROR_CODES.VALIDATION_FAILED, {
      fields: [isMissing(req.body.liters) ? "liters" : "cost"],
    });
  }

  const liters = toFiniteNumber(req.body.liters, "liters", { min: 0.1 });
  const cost = toFiniteNumber(req.body.cost, "cost", { min: 0 });

  const trip = await prisma.trip.findUnique({ where: { id: req.body.tripId } });
  if (!trip) throw notFound("Trip");

  if (trip.driverId !== driver.id) throw forbidden("This trip is not assigned to you.");
  if (trip.status !== "DISPATCHED") {
    throw badRequest("You can only log fuel against an active trip.", ERROR_CODES.ILLEGAL_TRANSITION);
  }

  const fuelLog = await prisma.fuelLog.create({
    data: {
      vehicleId: trip.vehicleId,
      tripId: trip.id,
      liters,
      cost,
      ...(isMissing(req.body.loggedAt) ? {} : { loggedAt: toDate(req.body.loggedAt, "loggedAt") }),
    },
  });

  await writeAudit({
    actor: req.user,
    entity: "FuelLog",
    entityId: fuelLog.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Driver ${driver.name} logged ${liters} L (₹${cost})`,
    after: { tripId: trip.id, liters, cost },
  });

  return res.status(201).json({
    success: true,
    message: `${liters} L logged — ₹${cost.toLocaleString("en-IN")}`,
    data: fuelLog,
  });
});

/** Tolls, parking and fines captured on the road. */
export const logMyExpense = asyncHandler(async (req, res) => {
  const driver = await requireDriverProfile(req);
  requireFields(req.body, ["tripId", "type"]);

  if (isMissing(req.body.amount)) {
    throw badRequest("Amount is required.", ERROR_CODES.VALIDATION_FAILED, { fields: ["amount"] });
  }

  const type = toEnum(req.body.type, DRIVER_EXPENSE_TYPES, "type");
  const amount = toFiniteNumber(req.body.amount, "amount", { min: 0 });

  const trip = await prisma.trip.findUnique({ where: { id: req.body.tripId } });
  if (!trip) throw notFound("Trip");

  if (trip.driverId !== driver.id) throw forbidden("This trip is not assigned to you.");
  if (trip.status !== "DISPATCHED") {
    throw badRequest(
      "You can only log expenses against an active trip.",
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  const expense = await prisma.expense.create({
    data: {
      vehicleId: trip.vehicleId,
      tripId: trip.id,
      type,
      amount,
      ...(isMissing(req.body.note) ? {} : { note: String(req.body.note).trim() }),
    },
  });

  // A self-reported fine still costs safety points (ISSUES #32).
  if (type === "FINE") await refreshSafetyScore(driver.id);

  await writeAudit({
    actor: req.user,
    entity: "Expense",
    entityId: expense.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Driver ${driver.name} logged ${type} of ₹${amount}`,
    after: { tripId: trip.id, type, amount },
  });

  return res.status(201).json({
    success: true,
    message: `${type.charAt(0)}${type.slice(1).toLowerCase()} of ₹${amount.toLocaleString("en-IN")} recorded`,
    data: expense,
  });
});
