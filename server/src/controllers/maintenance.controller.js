import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { badRequest, notFound, ERROR_CODES, conflict } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { auditOp, AUDIT_ACTIONS } from "../utils/audit.js";

export const createMaintenanceLog = asyncHandler(async (req, res) => {
  requireFields(req.body, ["vehicleId", "description"]);

  const { vehicleId, description, cost, resetServiceCounter } = req.body;

  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) throw notFound("Vehicle");

  if (vehicle.status === "ON_TRIP") {
    throw conflict(
      `Vehicle ${vehicle.registrationNo} is on a trip. Complete or cancel it before booking maintenance.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (vehicle.status === "RETIRED") {
    throw badRequest(
      `Vehicle ${vehicle.registrationNo} is retired.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  // ISSUES #9 — a second concurrent OPEN log on the same vehicle used to be
  // allowed, and closing either one released the vehicle while the other was
  // still open. One open work order per vehicle at a time.
  const existingOpen = await prisma.maintenanceLog.findFirst({
    where: { vehicleId, status: "OPEN" },
    select: { id: true, description: true, startedAt: true },
  });

  if (existingOpen) {
    throw conflict(
      `Vehicle ${vehicle.registrationNo} already has an open job: "${existingOpen.description}". Close it before opening another.`,
      ERROR_CODES.RESOURCE_BUSY,
      { existingLogId: existingOpen.id }
    );
  }

  const parsedCost = isMissing(cost) ? 0 : toFiniteNumber(cost, "cost", { min: 0 });

  const [log] = await prisma.$transaction([
    prisma.maintenanceLog.create({
      data: { vehicleId, description: String(description).trim(), cost: parsedCost },
    }),
    prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        status: "IN_SHOP",
        // ISSUES #34 — a full service resets the preventive-maintenance counter.
        ...(resetServiceCounter ? { lastServiceOdometer: vehicle.odometer } : {}),
      },
    }),
    auditOp({
      actor: req.user,
      entity: "MaintenanceLog",
      entityId: vehicleId,
      action: AUDIT_ACTIONS.OPEN,
      summary: `Opened "${description}" for ${vehicle.registrationNo}`,
      after: { description, cost: parsedCost, vehicleStatus: "IN_SHOP" },
    }),
  ]);

  return res.status(201).json({
    success: true,
    message: `${vehicle.registrationNo} moved to the shop`,
    data: log,
  });
});

export const getMaintenanceLogs = asyncHandler(async (req, res) => {
  const { vehicleId, status } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(vehicleId ? { vehicleId } : {}),
    ...(status ? { status } : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.maintenanceLog.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: { vehicle: { select: { id: true, registrationNo: true, name: true } } },
    }),
    prisma.maintenanceLog.count({ where }),
  ]);

  return paginated(res, logs, total, pagination);
});

export const getMaintenanceLogById = asyncHandler(async (req, res) => {
  const log = await prisma.maintenanceLog.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true },
  });

  if (!log) throw notFound("Maintenance log");

  return res.status(200).json({ success: true, data: log });
});

export const updateMaintenanceLog = asyncHandler(async (req, res) => {
  const { description, cost } = req.body;

  const log = await prisma.maintenanceLog.findUnique({ where: { id: req.params.id } });
  if (!log) throw notFound("Maintenance log");

  if (log.status === "CLOSED") {
    throw badRequest("This job is closed and can no longer be edited.", ERROR_CODES.ILLEGAL_TRANSITION);
  }

  const data = {};
  if (description !== undefined) data.description = String(description).trim();
  if (cost !== undefined) data.cost = toFiniteNumber(cost, "cost", { min: 0 });

  if (Object.keys(data).length === 0) throw badRequest("No changes were provided.");

  const [updated] = await prisma.$transaction([
    prisma.maintenanceLog.update({ where: { id: log.id }, data }),
    auditOp({
      actor: req.user,
      entity: "MaintenanceLog",
      entityId: log.id,
      action: AUDIT_ACTIONS.UPDATE,
      summary: `Updated maintenance job "${log.description}"`,
      before: log,
      after: { ...log, ...data },
    }),
  ]);

  return res.status(200).json({ success: true, message: "Maintenance job updated", data: updated });
});

export const closeMaintenanceLog = asyncHandler(async (req, res) => {
  const { cost, resetServiceCounter } = req.body || {};

  const log = await prisma.maintenanceLog.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true },
  });

  if (!log) throw notFound("Maintenance log");

  if (log.status !== "OPEN") {
    throw badRequest("This maintenance job is already closed.", ERROR_CODES.ILLEGAL_TRANSITION);
  }

  const finalCost = isMissing(cost) ? log.cost : toFiniteNumber(cost, "cost", { min: 0 });

  // ISSUES #9 — only release the vehicle when no other job is still open, and
  // never resurrect a vehicle that was retired while it sat in the shop.
  const otherOpen = await prisma.maintenanceLog.count({
    where: { vehicleId: log.vehicleId, status: "OPEN", id: { not: log.id } },
  });

  const shouldRelease = otherOpen === 0 && log.vehicle.status === "IN_SHOP";

  const [updatedLog] = await prisma.$transaction([
    prisma.maintenanceLog.update({
      where: { id: log.id },
      data: { status: "CLOSED", closedAt: new Date(), cost: finalCost },
    }),
    ...(shouldRelease
      ? [
          prisma.vehicle.update({
            where: { id: log.vehicleId },
            data: {
              status: "AVAILABLE",
              ...(resetServiceCounter ? { lastServiceOdometer: log.vehicle.odometer } : {}),
            },
          }),
        ]
      : []),
    auditOp({
      actor: req.user,
      entity: "MaintenanceLog",
      entityId: log.id,
      action: AUDIT_ACTIONS.CLOSE,
      summary: `Closed "${log.description}" for ${log.vehicle.registrationNo}${shouldRelease ? " — vehicle released" : ""}`,
      before: { status: "OPEN", cost: log.cost },
      after: { status: "CLOSED", cost: finalCost },
    }),
  ]);

  let message = `Job closed — ${log.vehicle.registrationNo} is available again`;
  if (!shouldRelease && otherOpen > 0) {
    message = `Job closed, but ${log.vehicle.registrationNo} stays in the shop (${otherOpen} job(s) still open)`;
  } else if (!shouldRelease) {
    message = `Job closed — ${log.vehicle.registrationNo} remains ${log.vehicle.status.toLowerCase().replace("_", " ")}`;
  }

  return res.status(200).json({ success: true, message, data: updatedLog });
});

/** ISSUES #34 — vehicles at or approaching their service interval. */
export const getServiceDueVehicles = asyncHandler(async (req, res) => {
  const warnKm = Number(req.query.warnKm) || 500;

  const vehicles = await prisma.vehicle.findMany({
    where: { serviceIntervalKm: { not: null }, status: { notIn: ["RETIRED"] } },
    orderBy: { odometer: "desc" },
  });

  const due = vehicles
    .map((v) => {
      const nextServiceAt = v.lastServiceOdometer + v.serviceIntervalKm;
      const kmRemaining = nextServiceAt - v.odometer;
      return { ...v, nextServiceAt, kmRemaining: Number(kmRemaining.toFixed(1)), overdue: kmRemaining < 0 };
    })
    .filter((v) => v.kmRemaining <= warnKm);

  return res.status(200).json({ success: true, data: due });
});
