import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  findVehicleConflicts,
  findDriverConflicts,
  getAvailableVehicles as findAvailableVehicles,
  getAvailableDrivers as findAvailableDrivers,
  describeConflict,
} from "../services/scheduling.service.js";
import { computeRevenue, explainRevenue } from "../services/pricing.service.js";
import { refreshSafetyScore, SAFETY_THRESHOLDS } from "../services/safety.service.js";
import { badRequest, notFound, conflict, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, toDate, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { auditOp, AUDIT_ACTIONS } from "../utils/audit.js";

const num = (value) => (value == null ? 0 : Number(value));

/** Default trip window when the caller supplies none: 40 km/h, minimum one hour. */
function defaultWindow(plannedDistance) {
  const start = new Date();
  const hours = Math.max(1, Math.ceil(Number(plannedDistance) / 40));
  return { plannedStart: start, plannedEnd: new Date(start.getTime() + hours * 3600_000) };
}

/**
 * ISSUES #31 — availability is now a question about a time window.
 * `?plannedStart=&plannedEnd=` returns everything free for that window; without
 * them the endpoint falls back to "free right now".
 */
export const getAvailableVehicles = asyncHandler(async (req, res) => {
  const { plannedStart, plannedEnd, cargoWeightKg } = req.query;

  const vehicles = await findAvailableVehicles({
    plannedStart: plannedStart ? toDate(plannedStart, "plannedStart") : null,
    plannedEnd: plannedEnd ? toDate(plannedEnd, "plannedEnd") : null,
    minLoadKg: cargoWeightKg ? Number(cargoWeightKg) : null,
  });

  return res.status(200).json({ success: true, data: vehicles });
});

export const getAvailableDrivers = asyncHandler(async (req, res) => {
  const { plannedStart, plannedEnd } = req.query;

  const drivers = await findAvailableDrivers({
    plannedStart: plannedStart ? toDate(plannedStart, "plannedStart") : null,
    plannedEnd: plannedEnd ? toDate(plannedEnd, "plannedEnd") : null,
  });

  return res.status(200).json({ success: true, data: drivers });
});

export const createTrip = asyncHandler(async (req, res) => {
  requireFields(req.body, ["source", "destination", "vehicleId", "driverId"]);

  const {
    source,
    destination,
    cargoWeightKg,
    plannedDistance,
    vehicleId,
    driverId,
    customerId,
    revenue,
  } = req.body;

  // ISSUES #20 — presence checked separately from numeric validity, so 0 is legal.
  if (isMissing(cargoWeightKg)) {
    throw badRequest("cargoWeightKg is required", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["cargoWeightKg"],
    });
  }
  if (isMissing(plannedDistance)) {
    throw badRequest("plannedDistance is required", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["plannedDistance"],
    });
  }

  const cargo = toFiniteNumber(cargoWeightKg, "cargoWeightKg", { min: 0 });
  const distance = toFiniteNumber(plannedDistance, "plannedDistance", { min: 1 });

  if (String(source).trim().toLowerCase() === String(destination).trim().toLowerCase()) {
    throw badRequest("Source and destination must be different.", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["destination"],
    });
  }

  // ---- scheduling window (ISSUES #31) ----
  const fallback = defaultWindow(distance);
  const plannedStart = isMissing(req.body.plannedStart)
    ? fallback.plannedStart
    : toDate(req.body.plannedStart, "plannedStart");
  const plannedEnd = isMissing(req.body.plannedEnd)
    ? new Date(plannedStart.getTime() + (fallback.plannedEnd - fallback.plannedStart))
    : toDate(req.body.plannedEnd, "plannedEnd");

  if (plannedEnd <= plannedStart) {
    throw badRequest(
      "The trip must end after it starts.",
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["plannedEnd"] }
    );
  }

  // ---- vehicle checks ----
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) throw notFound("Vehicle");

  if (vehicle.status === "RETIRED") {
    throw badRequest(
      `Vehicle ${vehicle.registrationNo} is retired and cannot be assigned.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (vehicle.status === "IN_SHOP") {
    throw conflict(
      `Vehicle ${vehicle.registrationNo} is in the shop and cannot be assigned.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (vehicle.insuranceExpired) {
    throw badRequest(
      `Vehicle ${vehicle.registrationNo} has expired insurance. Renew it before dispatching.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (cargo > vehicle.maxLoadKg) {
    throw badRequest(
      `Cargo weight (${cargo.toLocaleString("en-IN")} kg) exceeds ${vehicle.registrationNo}'s capacity of ${vehicle.maxLoadKg.toLocaleString("en-IN")} kg.`,
      ERROR_CODES.CAPACITY_EXCEEDED,
      { fields: ["cargoWeightKg"] }
    );
  }

  const vehicleConflicts = await findVehicleConflicts(vehicleId, plannedStart, plannedEnd);
  if (vehicleConflicts.length > 0) {
    throw conflict(
      `Vehicle ${vehicle.registrationNo} is already booked: ${describeConflict(vehicleConflicts[0])}.`,
      ERROR_CODES.SCHEDULE_CONFLICT,
      { conflicts: vehicleConflicts }
    );
  }

  // ---- driver checks ----
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Driver");

  if (driver.status === "SUSPENDED" || driver.status === "ARCHIVED") {
    throw badRequest(
      `${driver.name} is ${driver.status.toLowerCase()} and cannot be assigned.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  // A licence must be valid for the whole trip, not merely at booking time.
  if (new Date(driver.licenseExpiry) <= plannedEnd) {
    throw badRequest(
      `${driver.name}'s licence expires on ${new Date(driver.licenseExpiry).toLocaleDateString("en-IN")}, before this trip ends.`,
      ERROR_CODES.LICENSE_EXPIRED,
      { fields: ["driverId"] }
    );
  }

  // ISSUES #32 — the safety score is now an actual dispatch input.
  if (driver.safetyScore < SAFETY_THRESHOLDS.BLOCK) {
    throw badRequest(
      `${driver.name}'s safety score is ${driver.safetyScore}, below the minimum of ${SAFETY_THRESHOLDS.BLOCK}.`,
      ERROR_CODES.ILLEGAL_TRANSITION,
      { fields: ["driverId"] }
    );
  }

  const driverConflicts = await findDriverConflicts(driverId, plannedStart, plannedEnd);
  if (driverConflicts.length > 0) {
    throw conflict(
      `${driver.name} is already booked: ${describeConflict(driverConflicts[0])}.`,
      ERROR_CODES.SCHEDULE_CONFLICT,
      { conflicts: driverConflicts }
    );
  }

  // ---- revenue from the rate card (ISSUES #33) ----
  let customer = null;
  if (customerId) {
    customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw notFound("Customer");
  }

  const computed = computeRevenue({ customer, distanceKm: distance, cargoWeightKg: cargo });
  const finalRevenue = isMissing(revenue)
    ? computed
    : toFiniteNumber(revenue, "revenue", { min: 0 });

  const trip = await prisma.trip.create({
    data: {
      source: String(source).trim(),
      destination: String(destination).trim(),
      cargoWeightKg: cargo,
      plannedDistance: distance,
      plannedStart,
      plannedEnd,
      vehicleId,
      driverId,
      ...(customerId ? { customerId } : {}),
      ...(finalRevenue != null ? { revenue: finalRevenue } : {}),
    },
    include: { vehicle: true, driver: true, customer: true },
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.user?.id ?? null,
      actorEmail: req.user?.email ?? null,
      entity: "Trip",
      entityId: trip.id,
      action: AUDIT_ACTIONS.CREATE,
      summary: `Created trip ${trip.source} → ${trip.destination} for ${vehicle.registrationNo} / ${driver.name}`,
    },
  });

  const warnings = [];
  if (driver.safetyScore < SAFETY_THRESHOLDS.WARN) {
    warnings.push(
      `${driver.name}'s safety score is ${driver.safetyScore} — review before dispatching.`
    );
  }
  if (computed != null && !isMissing(revenue) && Number(revenue) !== computed) {
    warnings.push(
      `Revenue was overridden — the rate card computes ₹${computed.toLocaleString("en-IN")}.`
    );
  }

  return res.status(201).json({
    success: true,
    message: `Trip ${trip.source} → ${trip.destination} created`,
    warnings,
    revenueBasis: explainRevenue({ customer, distanceKm: distance, cargoWeightKg: cargo }),
    data: trip,
  });
});

export const getTrips = asyncHandler(async (req, res) => {
  const { status, vehicleId, driverId, customerId, from, to, search } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(status ? { status } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(driverId ? { driverId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(from || to
      ? {
          plannedStart: {
            ...(from ? { gte: toDate(from, "from") } : {}),
            ...(to ? { lte: toDate(to, "to") } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { source: { contains: search, mode: "insensitive" } },
            { destination: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [trips, total] = await Promise.all([
    prisma.trip.findMany({
      where,
      orderBy: { plannedStart: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        vehicle: { select: { id: true, registrationNo: true, name: true } },
        driver: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true } },
      },
    }),
    prisma.trip.count({ where }),
  ]);

  return paginated(res, trips, total, pagination);
});

/** ISSUES #35 — a trip now reports its own cost and margin, not just fleet-wide totals. */
export const getTripById = asyncHandler(async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true, driver: true, customer: true, fuelLogs: true, expenses: true },
  });

  if (!trip) throw notFound("Trip");

  const fuelCost = trip.fuelLogs.reduce((sum, log) => sum + num(log.cost), 0);
  const expenseCost = trip.expenses.reduce((sum, exp) => sum + num(exp.amount), 0);
  const totalCost = fuelCost + expenseCost;
  const revenue = num(trip.revenue);
  const actualDistance =
    trip.endOdometer != null && trip.startOdometer != null
      ? trip.endOdometer - trip.startOdometer
      : null;

  return res.status(200).json({
    success: true,
    data: {
      ...trip,
      economics: {
        revenue,
        fuelCost: Number(fuelCost.toFixed(2)),
        expenseCost: Number(expenseCost.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        margin: Number((revenue - totalCost).toFixed(2)),
        marginPercent: revenue > 0 ? Number((((revenue - totalCost) / revenue) * 100).toFixed(1)) : null,
        plannedDistance: trip.plannedDistance,
        actualDistance,
        // Planned-vs-actual variance, the signal an operator needs.
        distanceVariance: actualDistance != null ? Number((actualDistance - trip.plannedDistance).toFixed(1)) : null,
        costPerKm: actualDistance > 0 ? Number((totalCost / actualDistance).toFixed(2)) : null,
      },
    },
  });
});

export const updateTrip = asyncHandler(async (req, res) => {
  const trip = await prisma.trip.findUnique({ where: { id: req.params.id } });
  if (!trip) throw notFound("Trip");

  if (trip.status !== "DRAFT") {
    throw badRequest(
      `Only draft trips can be edited (this one is ${trip.status.toLowerCase()}).`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  const { source, destination, cargoWeightKg, plannedDistance, plannedStart, plannedEnd, customerId, revenue } =
    req.body;

  const data = {};
  if (source !== undefined) data.source = String(source).trim();
  if (destination !== undefined) data.destination = String(destination).trim();
  if (plannedDistance !== undefined) {
    data.plannedDistance = toFiniteNumber(plannedDistance, "plannedDistance", { min: 1 });
  }
  if (customerId !== undefined) data.customerId = customerId || null;
  if (revenue !== undefined) {
    data.revenue = isMissing(revenue) ? null : toFiniteNumber(revenue, "revenue", { min: 0 });
  }

  const nextStart = plannedStart !== undefined ? toDate(plannedStart, "plannedStart") : trip.plannedStart;
  const nextEnd = plannedEnd !== undefined ? toDate(plannedEnd, "plannedEnd") : trip.plannedEnd;

  if (nextEnd <= nextStart) {
    throw badRequest("The trip must end after it starts.", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["plannedEnd"],
    });
  }

  if (cargoWeightKg !== undefined) {
    const cargo = toFiniteNumber(cargoWeightKg, "cargoWeightKg", { min: 0 });
    const vehicle = await prisma.vehicle.findUnique({ where: { id: trip.vehicleId } });
    if (cargo > vehicle.maxLoadKg) {
      throw badRequest(
        `Cargo weight (${cargo.toLocaleString("en-IN")} kg) exceeds ${vehicle.registrationNo}'s capacity of ${vehicle.maxLoadKg.toLocaleString("en-IN")} kg.`,
        ERROR_CODES.CAPACITY_EXCEEDED,
        { fields: ["cargoWeightKg"] }
      );
    }
    data.cargoWeightKg = cargo;
  }

  // Re-check the schedule whenever the window moves.
  if (plannedStart !== undefined || plannedEnd !== undefined) {
    const [vConflicts, dConflicts] = await Promise.all([
      findVehicleConflicts(trip.vehicleId, nextStart, nextEnd, trip.id),
      findDriverConflicts(trip.driverId, nextStart, nextEnd, trip.id),
    ]);
    if (vConflicts.length > 0) {
      throw conflict(
        `That window clashes with another booking for this vehicle: ${describeConflict(vConflicts[0])}.`,
        ERROR_CODES.SCHEDULE_CONFLICT
      );
    }
    if (dConflicts.length > 0) {
      throw conflict(
        `That window clashes with another booking for this driver: ${describeConflict(dConflicts[0])}.`,
        ERROR_CODES.SCHEDULE_CONFLICT
      );
    }
    data.plannedStart = nextStart;
    data.plannedEnd = nextEnd;
  }

  if (Object.keys(data).length === 0) throw badRequest("No changes were provided.");

  const [updated] = await prisma.$transaction([
    prisma.trip.update({
      where: { id: trip.id },
      data,
      include: { vehicle: true, driver: true, customer: true },
    }),
    auditOp({
      actor: req.user,
      entity: "Trip",
      entityId: trip.id,
      action: AUDIT_ACTIONS.UPDATE,
      summary: `Updated draft trip ${trip.source} → ${trip.destination}`,
      before: trip,
      after: { ...trip, ...data },
    }),
  ]);

  return res.status(200).json({ success: true, message: "Trip updated", data: updated });
});

export const dispatchTrip = asyncHandler(async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true, driver: true },
  });

  if (!trip) throw notFound("Trip");

  if (trip.status !== "DRAFT") {
    throw badRequest(
      `Only draft trips can be dispatched (this one is ${trip.status.toLowerCase()}).`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  // Re-verify at dispatch time — the world may have moved since the draft was made.
  if (trip.vehicle.status === "IN_SHOP") {
    throw conflict(
      `Vehicle ${trip.vehicle.registrationNo} is in the shop.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (trip.vehicle.status === "RETIRED") {
    throw badRequest(
      `Vehicle ${trip.vehicle.registrationNo} has been retired.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (trip.vehicle.status === "ON_TRIP") {
    throw conflict(
      `Vehicle ${trip.vehicle.registrationNo} is already out on another trip.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (trip.vehicle.insuranceExpired) {
    throw badRequest(
      `Vehicle ${trip.vehicle.registrationNo} has expired insurance.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (["SUSPENDED", "ARCHIVED", "OFF_DUTY"].includes(trip.driver.status)) {
    throw badRequest(
      `${trip.driver.name} is ${trip.driver.status.replace("_", " ").toLowerCase()}.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (trip.driver.status === "ON_TRIP") {
    throw conflict(`${trip.driver.name} is already on another trip.`, ERROR_CODES.RESOURCE_BUSY);
  }
  if (new Date(trip.driver.licenseExpiry) <= new Date()) {
    throw badRequest(
      `${trip.driver.name}'s licence has expired.`,
      ERROR_CODES.LICENSE_EXPIRED
    );
  }

  const [updatedTrip] = await prisma.$transaction([
    prisma.trip.update({
      where: { id: trip.id },
      data: {
        status: "DISPATCHED",
        dispatchedAt: new Date(),
        startOdometer: trip.vehicle.odometer,
      },
      include: { vehicle: true, driver: true, customer: true },
    }),
    prisma.vehicle.update({ where: { id: trip.vehicleId }, data: { status: "ON_TRIP" } }),
    prisma.driver.update({ where: { id: trip.driverId }, data: { status: "ON_TRIP" } }),
    auditOp({
      actor: req.user,
      entity: "Trip",
      entityId: trip.id,
      action: AUDIT_ACTIONS.DISPATCH,
      summary: `Dispatched ${trip.source} → ${trip.destination} (${trip.vehicle.registrationNo} / ${trip.driver.name})`,
      before: { status: "DRAFT" },
      after: { status: "DISPATCHED", startOdometer: trip.vehicle.odometer },
    }),
  ]);

  return res.status(200).json({
    success: true,
    message: `Trip dispatched — ${trip.vehicle.registrationNo} is on the road`,
    data: updatedTrip,
  });
});

export const completeTrip = asyncHandler(async (req, res) => {
  const { endOdometer, fuelConsumedL, revenue } = req.body;

  if (isMissing(endOdometer)) {
    throw badRequest("The final odometer reading is required.", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["endOdometer"],
    });
  }

  const parsedEndOdometer = toFiniteNumber(endOdometer, "endOdometer", { min: 0 });

  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true, customer: true },
  });

  if (!trip) throw notFound("Trip");

  if (trip.status !== "DISPATCHED") {
    throw badRequest(
      `Only dispatched trips can be completed (this one is ${trip.status.toLowerCase()}).`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  if (parsedEndOdometer < trip.vehicle.odometer) {
    throw badRequest(
      `The final odometer (${parsedEndOdometer.toLocaleString("en-IN")} km) cannot be lower than the vehicle's current reading of ${trip.vehicle.odometer.toLocaleString("en-IN")} km.`,
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["endOdometer"] }
    );
  }

  const parsedFuel = isMissing(fuelConsumedL)
    ? null
    : toFiniteNumber(fuelConsumedL, "fuelConsumedL", { min: 0 });

  // Fall back to the rate card when no figure is supplied (ISSUES #33).
  const computed = computeRevenue({
    customer: trip.customer,
    distanceKm: trip.plannedDistance,
    cargoWeightKg: trip.cargoWeightKg,
  });
  const parsedRevenue = isMissing(revenue)
    ? (trip.revenue != null ? Number(trip.revenue) : computed)
    : toFiniteNumber(revenue, "revenue", { min: 0 });

  const actualDistance = parsedEndOdometer - (trip.startOdometer ?? trip.vehicle.odometer);

  const [updatedTrip] = await prisma.$transaction([
    prisma.trip.update({
      where: { id: trip.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        endOdometer: parsedEndOdometer,
        ...(parsedFuel != null ? { fuelConsumedL: parsedFuel } : {}),
        ...(parsedRevenue != null ? { revenue: parsedRevenue } : {}),
      },
      include: { vehicle: true, driver: true, customer: true },
    }),
    prisma.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "AVAILABLE", odometer: parsedEndOdometer },
    }),
    prisma.driver.update({ where: { id: trip.driverId }, data: { status: "AVAILABLE" } }),
    auditOp({
      actor: req.user,
      entity: "Trip",
      entityId: trip.id,
      action: AUDIT_ACTIONS.COMPLETE,
      summary: `Completed ${trip.source} → ${trip.destination} — ${actualDistance.toLocaleString("en-IN")} km`,
      before: { status: "DISPATCHED", odometer: trip.vehicle.odometer },
      after: { status: "COMPLETED", endOdometer: parsedEndOdometer, revenue: parsedRevenue },
    }),
  ]);

  // Completions raise the driver's score (ISSUES #32).
  await refreshSafetyScore(trip.driverId);

  const warnings = [];
  const variance = actualDistance - trip.plannedDistance;
  if (Math.abs(variance) > trip.plannedDistance * 0.2) {
    warnings.push(
      `Actual distance (${actualDistance.toLocaleString("en-IN")} km) differs from the plan by ${variance > 0 ? "+" : ""}${Math.round(variance).toLocaleString("en-IN")} km.`
    );
  }

  // ISSUES #34 — preventive service check on the fresh odometer reading.
  const vehicle = updatedTrip.vehicle;
  if (vehicle.serviceIntervalKm) {
    const nextServiceAt = vehicle.lastServiceOdometer + vehicle.serviceIntervalKm;
    if (vehicle.odometer >= nextServiceAt) {
      warnings.push(
        `${vehicle.registrationNo} is due for service — ${Math.round(vehicle.odometer - nextServiceAt).toLocaleString("en-IN")} km past its interval.`
      );
    }
  }

  return res.status(200).json({
    success: true,
    message: `Trip completed — ${actualDistance.toLocaleString("en-IN")} km recorded`,
    warnings,
    data: updatedTrip,
  });
});

export const cancelTrip = asyncHandler(async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id },
    include: { vehicle: true, driver: true },
  });

  if (!trip) throw notFound("Trip");

  if (trip.status !== "DRAFT" && trip.status !== "DISPATCHED") {
    throw badRequest(
      `This trip is already ${trip.status.toLowerCase()} and cannot be cancelled.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  const wasDispatched = trip.status === "DISPATCHED";

  const [updatedTrip] = await prisma.$transaction([
    prisma.trip.update({
      where: { id: trip.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      include: { vehicle: true, driver: true, customer: true },
    }),
    // Resources are only released if they were actually reserved.
    ...(wasDispatched
      ? [
          prisma.vehicle.update({ where: { id: trip.vehicleId }, data: { status: "AVAILABLE" } }),
          prisma.driver.update({ where: { id: trip.driverId }, data: { status: "AVAILABLE" } }),
        ]
      : []),
    auditOp({
      actor: req.user,
      entity: "Trip",
      entityId: trip.id,
      action: AUDIT_ACTIONS.CANCEL,
      summary: `Cancelled ${trip.source} → ${trip.destination}${req.body?.reason ? ` — ${req.body.reason}` : ""}`,
      before: { status: trip.status },
      after: { status: "CANCELLED" },
    }),
  ]);

  // Cancelling after dispatch costs the driver safety points (ISSUES #32).
  if (wasDispatched) await refreshSafetyScore(trip.driverId);

  return res.status(200).json({
    success: true,
    message: wasDispatched
      ? `Trip cancelled — ${trip.vehicle.registrationNo} and ${trip.driver.name} are free again`
      : "Draft trip cancelled",
    data: updatedTrip,
  });
});

/** ISSUES #31 — calendar feed for the dispatch timeline. */
export const getSchedule = asyncHandler(async (req, res) => {
  const from = req.query.from ? toDate(req.query.from, "from") : new Date();
  const to = req.query.to
    ? toDate(req.query.to, "to")
    : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const trips = await prisma.trip.findMany({
    where: {
      status: { in: ["DRAFT", "DISPATCHED"] },
      plannedStart: { lt: to },
      plannedEnd: { gt: from },
    },
    orderBy: { plannedStart: "asc" },
    include: {
      vehicle: { select: { id: true, registrationNo: true, name: true } },
      driver: { select: { id: true, name: true } },
    },
  });

  return res.status(200).json({ success: true, data: trips, meta: { from, to } });
});
