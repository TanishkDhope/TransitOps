import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { badRequest, notFound, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, toDate, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

export const createFuelLog = asyncHandler(async (req, res) => {
  requireFields(req.body, ["vehicleId"]);

  const { vehicleId, tripId, liters, cost, loggedAt } = req.body;

  // ISSUES #20 — presence and numeric validity checked separately.
  if (isMissing(liters)) {
    throw badRequest("liters is required", ERROR_CODES.VALIDATION_FAILED, { fields: ["liters"] });
  }
  if (isMissing(cost)) {
    throw badRequest("cost is required", ERROR_CODES.VALIDATION_FAILED, { fields: ["cost"] });
  }

  const parsedLiters = toFiniteNumber(liters, "liters", { min: 0.1 });
  const parsedCost = toFiniteNumber(cost, "cost", { min: 0 });

  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) throw notFound("Vehicle");

  // A fuel log tied to a trip must belong to that trip's vehicle, or the
  // per-vehicle fuel efficiency report silently attributes fuel to the wrong asset.
  if (tripId) {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, vehicleId: true, source: true, destination: true },
    });
    if (!trip) throw notFound("Trip");
    if (trip.vehicleId !== vehicleId) {
      throw badRequest(
        `That trip (${trip.source} → ${trip.destination}) was run by a different vehicle.`,
        ERROR_CODES.VALIDATION_FAILED,
        { fields: ["tripId"] }
      );
    }
  }

  const fuelLog = await prisma.fuelLog.create({
    data: {
      vehicleId,
      ...(tripId ? { tripId } : {}),
      liters: parsedLiters,
      cost: parsedCost,
      ...(isMissing(loggedAt) ? {} : { loggedAt: toDate(loggedAt, "loggedAt") }),
    },
    include: { vehicle: { select: { registrationNo: true, name: true } } },
  });

  await writeAudit({
    actor: req.user,
    entity: "FuelLog",
    entityId: fuelLog.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Logged ${parsedLiters} L (₹${parsedCost}) for ${vehicle.registrationNo}`,
    after: { vehicleId, tripId, liters: parsedLiters, cost: parsedCost },
  });

  return res.status(201).json({
    success: true,
    message: `Fuel log added for ${vehicle.registrationNo}`,
    data: fuelLog,
  });
});

export const getFuelLogs = asyncHandler(async (req, res) => {
  const { vehicleId, tripId, from, to } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(vehicleId ? { vehicleId } : {}),
    ...(tripId ? { tripId } : {}),
    ...(from || to
      ? {
          loggedAt: {
            ...(from ? { gte: toDate(from, "from") } : {}),
            ...(to ? { lte: toDate(to, "to") } : {}),
          },
        }
      : {}),
  };

  const [fuelLogs, total, aggregate] = await Promise.all([
    prisma.fuelLog.findMany({
      where,
      orderBy: { loggedAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: { vehicle: { select: { id: true, registrationNo: true, name: true } } },
    }),
    prisma.fuelLog.count({ where }),
    // Totals must cover the whole filtered set, not just the current page.
    prisma.fuelLog.aggregate({ where, _sum: { liters: true, cost: true } }),
  ]);

  return paginated(res, fuelLogs, total, pagination, {
    totals: {
      liters: aggregate._sum.liters ?? 0,
      cost: Number(aggregate._sum.cost ?? 0),
    },
  });
});

export const deleteFuelLog = asyncHandler(async (req, res) => {
  const log = await prisma.fuelLog.findUnique({ where: { id: req.params.id } });
  if (!log) throw notFound("Fuel log");

  await prisma.fuelLog.delete({ where: { id: log.id } });

  await writeAudit({
    actor: req.user,
    entity: "FuelLog",
    entityId: log.id,
    action: AUDIT_ACTIONS.DELETE,
    summary: `Deleted fuel log of ${log.liters} L`,
    before: log,
  });

  return res.status(200).json({ success: true, message: "Fuel log deleted", data: { id: log.id } });
});
