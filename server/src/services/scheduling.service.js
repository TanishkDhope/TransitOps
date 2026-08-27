// ISSUES #31 — Trips now carry a planned window, so availability is an
// interval-overlap question rather than "is this vehicle free right now".

import prisma from "../db/prisma.js";

/** Statuses that reserve a vehicle/driver for their planned window. */
const BLOCKING_STATUSES = ["DRAFT", "DISPATCHED"];

/**
 * Standard half-open overlap test: [aStart, aEnd) intersects [bStart, bEnd)
 * iff aStart < bEnd AND aEnd > bStart. Back-to-back trips do not conflict.
 */
function overlapWhere(plannedStart, plannedEnd) {
  return {
    plannedStart: { lt: plannedEnd },
    plannedEnd: { gt: plannedStart },
  };
}

/** Trips that would clash with the given window for this vehicle. */
export async function findVehicleConflicts(vehicleId, plannedStart, plannedEnd, excludeTripId) {
  return prisma.trip.findMany({
    where: {
      vehicleId,
      status: { in: BLOCKING_STATUSES },
      ...(excludeTripId ? { id: { not: excludeTripId } } : {}),
      ...overlapWhere(plannedStart, plannedEnd),
    },
    select: {
      id: true,
      source: true,
      destination: true,
      plannedStart: true,
      plannedEnd: true,
      status: true,
    },
    orderBy: { plannedStart: "asc" },
  });
}

/** Trips that would clash with the given window for this driver. */
export async function findDriverConflicts(driverId, plannedStart, plannedEnd, excludeTripId) {
  return prisma.trip.findMany({
    where: {
      driverId,
      status: { in: BLOCKING_STATUSES },
      ...(excludeTripId ? { id: { not: excludeTripId } } : {}),
      ...overlapWhere(plannedStart, plannedEnd),
    },
    select: {
      id: true,
      source: true,
      destination: true,
      plannedStart: true,
      plannedEnd: true,
      status: true,
    },
    orderBy: { plannedStart: "asc" },
  });
}

/** Human-readable description of a clashing trip, for the error message. */
export function describeConflict(trip) {
  const start = new Date(trip.plannedStart).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const end = new Date(trip.plannedEnd).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${trip.source} → ${trip.destination} (${start} – ${end})`;
}

/**
 * Vehicles free for the whole window: not retired, not in the shop, and with no
 * overlapping booking. A vehicle currently ON_TRIP is still offerable for a
 * future window, which is the entire point of scheduling.
 */
export async function getAvailableVehicles({ plannedStart, plannedEnd, minLoadKg } = {}) {
  const vehicles = await prisma.vehicle.findMany({
    where: {
      status: { notIn: ["RETIRED", "IN_SHOP"] },
      ...(minLoadKg != null ? { maxLoadKg: { gte: minLoadKg } } : {}),
    },
    orderBy: { name: "asc" },
  });

  if (!plannedStart || !plannedEnd) {
    return vehicles.filter((v) => v.status === "AVAILABLE");
  }

  const conflicts = await prisma.trip.findMany({
    where: {
      vehicleId: { in: vehicles.map((v) => v.id) },
      status: { in: BLOCKING_STATUSES },
      ...overlapWhere(plannedStart, plannedEnd),
    },
    select: { vehicleId: true },
  });

  const busy = new Set(conflicts.map((c) => c.vehicleId));
  return vehicles.filter((v) => !busy.has(v.id));
}

/**
 * Drivers free for the whole window with a licence valid at the END of it —
 * a licence that expires mid-trip is not usable for that trip.
 */
export async function getAvailableDrivers({ plannedStart, plannedEnd, minSafetyScore } = {}) {
  const licenceCutoff = plannedEnd ?? new Date();

  const drivers = await prisma.driver.findMany({
    where: {
      status: { notIn: ["SUSPENDED", "ARCHIVED", "OFF_DUTY"] },
      licenseExpiry: { gt: licenceCutoff },
      ...(minSafetyScore != null ? { safetyScore: { gte: minSafetyScore } } : {}),
    },
    orderBy: { name: "asc" },
  });

  if (!plannedStart || !plannedEnd) {
    return drivers.filter((d) => d.status === "AVAILABLE");
  }

  const conflicts = await prisma.trip.findMany({
    where: {
      driverId: { in: drivers.map((d) => d.id) },
      status: { in: BLOCKING_STATUSES },
      ...overlapWhere(plannedStart, plannedEnd),
    },
    select: { driverId: true },
  });

  const busy = new Set(conflicts.map((c) => c.driverId));
  return drivers.filter((d) => !busy.has(d.id));
}

export default {
  findVehicleConflicts,
  findDriverConflicts,
  getAvailableVehicles,
  getAvailableDrivers,
  describeConflict,
};
