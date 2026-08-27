import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";

/**
 * ISSUES #18 — the type/region filters used to apply only to the vehicle counts,
 * so with "Truck" selected the vehicle KPIs were truck-only, the trip KPIs were
 * fleet-wide, and the table below was truck-only: three scopes on one screen.
 * Trip and driver counts are now scoped through the vehicle relation too.
 */
export const getKpis = asyncHandler(async (req, res) => {
  const { type, region } = req.query;

  const vehicleFilter = {
    ...(type ? { type } : {}),
    ...(region ? { region } : {}),
  };

  const hasFilter = Object.keys(vehicleFilter).length > 0;

  // When a filter is active, trips and drivers are scoped via their vehicle.
  const tripFilter = hasFilter ? { vehicle: vehicleFilter } : {};
  const driverOnTripFilter = hasFilter
    ? { status: "ON_TRIP", trips: { some: { status: "DISPATCHED", vehicle: vehicleFilter } } }
    : { status: "ON_TRIP" };

  const [
    activeVehicles,
    availableVehicles,
    vehiclesInMaintenance,
    onTripVehicles,
    retiredVehicles,
    activeTrips,
    pendingTrips,
    driversOnDuty,
    totalDrivers,
    expiringSoon,
    complianceIssues,
  ] = await Promise.all([
    prisma.vehicle.count({ where: { ...vehicleFilter, status: { not: "RETIRED" } } }),
    prisma.vehicle.count({ where: { ...vehicleFilter, status: "AVAILABLE" } }),
    prisma.vehicle.count({ where: { ...vehicleFilter, status: "IN_SHOP" } }),
    prisma.vehicle.count({ where: { ...vehicleFilter, status: "ON_TRIP" } }),
    prisma.vehicle.count({ where: { ...vehicleFilter, status: "RETIRED" } }),
    prisma.trip.count({ where: { ...tripFilter, status: "DISPATCHED" } }),
    prisma.trip.count({ where: { ...tripFilter, status: "DRAFT" } }),
    prisma.driver.count({ where: driverOnTripFilter }),
    prisma.driver.count({ where: { status: { notIn: ["ARCHIVED"] } } }),
    prisma.driver.count({
      where: {
        status: { notIn: ["ARCHIVED", "SUSPENDED"] },
        licenseExpiry: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.vehicle.count({
      where: {
        ...vehicleFilter,
        status: { not: "RETIRED" },
        OR: [{ insuranceExpired: true }, { pucExpired: true }],
      },
    }),
  ]);

  /**
   * ISSUES #17 — utilisation is now measured against *deployable* capacity.
   * Counting IN_SHOP vehicles in the denominator understated the figure and made
   * it move whenever a maintenance job opened, which is not what utilisation means.
   */
  const deployableVehicles = availableVehicles + onTripVehicles;
  const fleetUtilization =
    deployableVehicles > 0 ? (onTripVehicles / deployableVehicles) * 100 : 0;

  return res.status(200).json({
    success: true,
    data: {
      activeVehicles,
      availableVehicles,
      vehiclesInMaintenance,
      onTripVehicles,
      retiredVehicles,
      deployableVehicles,
      activeTrips,
      pendingTrips,
      driversOnDuty,
      totalDrivers,
      licensesExpiringSoon: expiringSoon,
      complianceIssues,
      fleetUtilization: Number(fleetUtilization.toFixed(2)),
    },
    meta: {
      // Makes the scope explicit so the UI can label the KPI strip honestly.
      filtered: hasFilter,
      filters: { type: type ?? null, region: region ?? null },
      utilizationBasis: "onTrip / (available + onTrip)",
    },
  });
});

/** Compliance and scheduling items that need attention, for the dashboard alert strip. */
export const getAlerts = asyncHandler(async (req, res) => {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [expiredInsurance, expiredPuc, expiringLicenses, serviceDue, overdueTrips] =
    await Promise.all([
      prisma.vehicle.findMany({
        where: { insuranceExpired: true, status: { not: "RETIRED" } },
        select: { id: true, registrationNo: true, name: true, insuranceExpiry: true },
        take: 20,
      }),
      prisma.vehicle.findMany({
        where: { pucExpired: true, status: { not: "RETIRED" } },
        select: { id: true, registrationNo: true, name: true, pucExpiry: true },
        take: 20,
      }),
      prisma.driver.findMany({
        where: {
          status: { notIn: ["ARCHIVED", "SUSPENDED"] },
          licenseExpiry: { lte: in30Days },
        },
        select: { id: true, name: true, licenseNumber: true, licenseExpiry: true },
        orderBy: { licenseExpiry: "asc" },
        take: 20,
      }),
      prisma.vehicle.findMany({
        where: { serviceIntervalKm: { not: null }, status: { not: "RETIRED" } },
        select: {
          id: true,
          registrationNo: true,
          name: true,
          odometer: true,
          lastServiceOdometer: true,
          serviceIntervalKm: true,
        },
      }),
      // Dispatched trips that have run past their planned end time (ISSUES #31).
      prisma.trip.findMany({
        where: { status: "DISPATCHED", plannedEnd: { lt: now } },
        select: {
          id: true,
          source: true,
          destination: true,
          plannedEnd: true,
          vehicle: { select: { registrationNo: true } },
          driver: { select: { name: true } },
        },
        take: 20,
      }),
    ]);

  const dueForService = serviceDue
    .map((v) => ({
      ...v,
      kmRemaining: Number((v.lastServiceOdometer + v.serviceIntervalKm - v.odometer).toFixed(1)),
    }))
    .filter((v) => v.kmRemaining <= 500);

  const total =
    expiredInsurance.length +
    expiredPuc.length +
    expiringLicenses.length +
    dueForService.length +
    overdueTrips.length;

  return res.status(200).json({
    success: true,
    data: {
      total,
      expiredInsurance,
      expiredPuc,
      expiringLicenses,
      dueForService,
      overdueTrips,
    },
  });
});
