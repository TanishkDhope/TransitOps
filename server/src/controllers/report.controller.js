import PDFDocument from "pdfkit";

import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { badRequest } from "../utils/ApiError.js";
import { toDate } from "../utils/validators.js";

const toNumber = (value) => (value == null ? 0 : Number(value));
const round2 = (value) => Number(value.toFixed(2));

/** Optional `?from=&to=` range applied consistently across every report. */
function dateRange(query) {
  const from = query?.from ? toDate(query.from, "from") : null;
  const to = query?.to ? toDate(query.to, "to") : null;
  return { from, to };
}

function withinRange(field, { from, to }) {
  if (!from && !to) return {};
  return {
    [field]: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Fuel efficiency — ISSUES #13
// ---------------------------------------------------------------------------

/**
 * The numerator used to count only completed trips while the denominator counted
 * every fuel log ever recorded, biasing every vehicle's km/L low.
 *
 * Both sides now cover the same set of completed trips: distance from odometer
 * readings, litres from fuel logs *linked to those trips*. Fuel that was never
 * attributed to a trip is reported separately as `unattributedLiters` rather
 * than silently corrupting the ratio.
 */
async function buildFuelEfficiencyReport(range = {}) {
  const tripWhere = { status: "COMPLETED", ...withinRange("completedAt", range) };

  const vehicles = await prisma.vehicle.findMany({
    include: {
      trips: {
        where: tripWhere,
        select: { id: true, startOdometer: true, endOdometer: true, fuelConsumedL: true },
      },
      fuelLogs: {
        where: withinRange("loggedAt", range),
        select: { liters: true, tripId: true },
      },
    },
    orderBy: { registrationNo: "asc" },
  });

  return vehicles.map((vehicle) => {
    const completedTripIds = new Set(vehicle.trips.map((t) => t.id));

    const totalDistance = vehicle.trips.reduce((sum, trip) => {
      if (trip.startOdometer == null || trip.endOdometer == null) return sum;
      return sum + Math.max(0, trip.endOdometer - trip.startOdometer);
    }, 0);

    const attributedLiters = vehicle.fuelLogs
      .filter((log) => log.tripId && completedTripIds.has(log.tripId))
      .reduce((sum, log) => sum + toNumber(log.liters), 0);

    const unattributedLiters = vehicle.fuelLogs
      .filter((log) => !log.tripId || !completedTripIds.has(log.tripId))
      .reduce((sum, log) => sum + toNumber(log.liters), 0);

    // Prefer the odometer-derived litres; fall back to the per-trip declaration
    // when no fuel logs were linked, so a vehicle is not reported as "no data".
    const declaredLiters = vehicle.trips.reduce((sum, t) => sum + toNumber(t.fuelConsumedL), 0);
    const basisLiters = attributedLiters > 0 ? attributedLiters : declaredLiters;

    return {
      vehicleId: vehicle.id,
      registrationNo: vehicle.registrationNo,
      name: vehicle.name,
      totalDistance: round2(totalDistance),
      totalFuelLiters: round2(basisLiters),
      unattributedLiters: round2(unattributedLiters),
      basis: attributedLiters > 0 ? "trip-linked fuel logs" : "declared trip fuel",
      fuelEfficiencyKmPerL: basisLiters > 0 ? round2(totalDistance / basisLiters) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Fleet utilisation — ISSUES #17
// ---------------------------------------------------------------------------

async function buildFleetUtilizationReport() {
  const vehicles = await prisma.vehicle.findMany({ select: { status: true } });

  const activeVehicles = vehicles.filter((v) => v.status !== "RETIRED");
  const onTrip = activeVehicles.filter((v) => v.status === "ON_TRIP");
  const inShop = activeVehicles.filter((v) => v.status === "IN_SHOP");
  const available = activeVehicles.filter((v) => v.status === "AVAILABLE");

  // Same definition as the dashboard: utilisation measures deployable capacity.
  const deployable = available.length + onTrip.length;

  return [
    {
      totalActiveVehicles: activeVehicles.length,
      deployableVehicles: deployable,
      vehiclesOnTrip: onTrip.length,
      vehiclesInShop: inShop.length,
      fleetUtilizationPercent: deployable > 0 ? round2((onTrip.length / deployable) * 100) : 0,
    },
  ];
}

// ---------------------------------------------------------------------------
// Operational cost — ISSUES #12
// ---------------------------------------------------------------------------

/**
 * `Expense` rows (tolls, parking, fines) used to be excluded entirely, so this
 * report disagreed with the Fuel & Expenses page and systematically overstated ROI.
 * All three cost streams are now included, and MAINTENANCE-type expenses are
 * rejected at creation so nothing is double-counted against maintenance logs.
 */
async function buildOperationalCostReport(range = {}) {
  const vehicles = await prisma.vehicle.findMany({
    include: {
      fuelLogs: { where: withinRange("loggedAt", range), select: { cost: true } },
      maintenanceLogs: { where: withinRange("startedAt", range), select: { cost: true } },
      expenses: { where: withinRange("incurredAt", range), select: { amount: true } },
    },
    orderBy: { registrationNo: "asc" },
  });

  return vehicles.map((vehicle) => {
    const fuelCost = vehicle.fuelLogs.reduce((sum, log) => sum + toNumber(log.cost), 0);
    const maintenanceCost = vehicle.maintenanceLogs.reduce((sum, log) => sum + toNumber(log.cost), 0);
    const otherExpenses = vehicle.expenses.reduce((sum, exp) => sum + toNumber(exp.amount), 0);

    return {
      vehicleId: vehicle.id,
      registrationNo: vehicle.registrationNo,
      name: vehicle.name,
      fuelCost: round2(fuelCost),
      maintenanceCost: round2(maintenanceCost),
      otherExpenses: round2(otherExpenses),
      totalOperationalCost: round2(fuelCost + maintenanceCost + otherExpenses),
    };
  });
}

// ---------------------------------------------------------------------------
// Vehicle ROI
// ---------------------------------------------------------------------------

async function buildVehicleRoiReport(range = {}) {
  const vehicles = await prisma.vehicle.findMany({
    include: {
      trips: {
        where: { status: "COMPLETED", ...withinRange("completedAt", range) },
        select: { revenue: true },
      },
      fuelLogs: { where: withinRange("loggedAt", range), select: { cost: true } },
      maintenanceLogs: { where: withinRange("startedAt", range), select: { cost: true } },
      expenses: { where: withinRange("incurredAt", range), select: { amount: true } },
    },
    orderBy: { registrationNo: "asc" },
  });

  return vehicles.map((vehicle) => {
    const revenue = vehicle.trips.reduce((sum, trip) => sum + toNumber(trip.revenue), 0);
    const fuelCost = vehicle.fuelLogs.reduce((sum, log) => sum + toNumber(log.cost), 0);
    const maintenanceCost = vehicle.maintenanceLogs.reduce((sum, log) => sum + toNumber(log.cost), 0);
    const otherExpenses = vehicle.expenses.reduce((sum, exp) => sum + toNumber(exp.amount), 0);

    const totalCost = fuelCost + maintenanceCost + otherExpenses;
    const acquisitionCost = toNumber(vehicle.acquisitionCost);
    const netProfit = revenue - totalCost;

    return {
      vehicleId: vehicle.id,
      registrationNo: vehicle.registrationNo,
      name: vehicle.name,
      revenue: round2(revenue),
      fuelCost: round2(fuelCost),
      maintenanceCost: round2(maintenanceCost),
      otherExpenses: round2(otherExpenses),
      totalCost: round2(totalCost),
      netProfit: round2(netProfit),
      acquisitionCost,
      roi: acquisitionCost > 0 ? Number((netProfit / acquisitionCost).toFixed(4)) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Trip profitability — ISSUES #35
// ---------------------------------------------------------------------------

/** Per-trip margin: the decision an operator actually needs to make. */
async function buildTripProfitabilityReport(range = {}) {
  const trips = await prisma.trip.findMany({
    where: { status: "COMPLETED", ...withinRange("completedAt", range) },
    include: {
      vehicle: { select: { registrationNo: true } },
      driver: { select: { name: true } },
      customer: { select: { name: true } },
      fuelLogs: { select: { cost: true } },
      expenses: { select: { amount: true } },
    },
    orderBy: { completedAt: "desc" },
  });

  return trips.map((trip) => {
    const revenue = toNumber(trip.revenue);
    const fuelCost = trip.fuelLogs.reduce((sum, log) => sum + toNumber(log.cost), 0);
    const expenseCost = trip.expenses.reduce((sum, exp) => sum + toNumber(exp.amount), 0);
    const totalCost = fuelCost + expenseCost;
    const actualDistance =
      trip.startOdometer != null && trip.endOdometer != null
        ? trip.endOdometer - trip.startOdometer
        : trip.plannedDistance;

    return {
      tripId: trip.id,
      route: `${trip.source} → ${trip.destination}`,
      customer: trip.customer?.name ?? "—",
      registrationNo: trip.vehicle.registrationNo,
      driver: trip.driver.name,
      distance: round2(actualDistance),
      revenue: round2(revenue),
      totalCost: round2(totalCost),
      margin: round2(revenue - totalCost),
      marginPercent: revenue > 0 ? round2(((revenue - totalCost) / revenue) * 100) : null,
      costPerKm: actualDistance > 0 ? round2(totalCost / actualDistance) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Lane profitability — ISSUES #35
// ---------------------------------------------------------------------------

/** Aggregates completed trips by route so loss-making lanes become visible. */
async function buildLaneProfitabilityReport(range = {}) {
  const trips = await buildTripProfitabilityReport(range);

  const lanes = new Map();
  for (const trip of trips) {
    const existing = lanes.get(trip.route) ?? {
      route: trip.route,
      trips: 0,
      revenue: 0,
      totalCost: 0,
      distance: 0,
    };
    existing.trips += 1;
    existing.revenue += trip.revenue;
    existing.totalCost += trip.totalCost;
    existing.distance += trip.distance;
    lanes.set(trip.route, existing);
  }

  return Array.from(lanes.values())
    .map((lane) => ({
      ...lane,
      revenue: round2(lane.revenue),
      totalCost: round2(lane.totalCost),
      distance: round2(lane.distance),
      margin: round2(lane.revenue - lane.totalCost),
      marginPercent: lane.revenue > 0 ? round2(((lane.revenue - lane.totalCost) / lane.revenue) * 100) : null,
      avgCostPerKm: lane.distance > 0 ? round2(lane.totalCost / lane.distance) : null,
    }))
    .sort((a, b) => a.margin - b.margin); // worst lanes first — that is the point
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REPORT_BUILDERS = {
  "fuel-efficiency": buildFuelEfficiencyReport,
  "fleet-utilization": buildFleetUtilizationReport,
  "operational-cost": buildOperationalCostReport,
  "vehicle-roi": buildVehicleRoiReport,
  "trip-profitability": buildTripProfitabilityReport,
  "lane-profitability": buildLaneProfitabilityReport,
};

export const getFuelEfficiencyReport = asyncHandler(async (req, res) => {
  const data = await buildFuelEfficiencyReport(dateRange(req.query));
  return res.status(200).json({ success: true, data });
});

export const getFleetUtilizationReport = asyncHandler(async (req, res) => {
  const data = await buildFleetUtilizationReport();
  return res.status(200).json({ success: true, data: data[0] });
});

export const getOperationalCostReport = asyncHandler(async (req, res) => {
  const data = await buildOperationalCostReport(dateRange(req.query));
  return res.status(200).json({ success: true, data });
});

export const getVehicleRoiReport = asyncHandler(async (req, res) => {
  const data = await buildVehicleRoiReport(dateRange(req.query));
  return res.status(200).json({ success: true, data });
});

export const getTripProfitabilityReport = asyncHandler(async (req, res) => {
  const data = await buildTripProfitabilityReport(dateRange(req.query));
  return res.status(200).json({ success: true, data });
});

export const getLaneProfitabilityReport = asyncHandler(async (req, res) => {
  const data = await buildLaneProfitabilityReport(dateRange(req.query));
  return res.status(200).json({ success: true, data });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const toCsv = (rows) => {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => JSON.stringify(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
};

function resolveBuilder(report) {
  const builder = REPORT_BUILDERS[report];
  if (!builder) {
    throw badRequest(
      `Unknown report "${report ?? ""}". Valid options: ${Object.keys(REPORT_BUILDERS).join(", ")}`
    );
  }
  return builder;
}

export const exportReportCsv = asyncHandler(async (req, res) => {
  const builder = resolveBuilder(req.query.report);
  const data = await builder(dateRange(req.query));

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${req.query.report}.csv"`);
  return res.status(200).send(toCsv(data));
});

const REPORT_LABELS = {
  "fuel-efficiency": "Fuel Efficiency Report",
  "fleet-utilization": "Fleet Utilization Report",
  "operational-cost": "Operational Cost Report",
  "vehicle-roi": "Vehicle ROI Report",
  "trip-profitability": "Trip Profitability Report",
  "lane-profitability": "Lane Profitability Report",
};

const REPORT_COLUMNS = {
  "fuel-efficiency": [
    { key: "registrationNo", label: "Reg. No", width: 85 },
    { key: "name", label: "Vehicle", width: 105 },
    { key: "totalDistance", label: "Distance (km)", width: 95 },
    { key: "totalFuelLiters", label: "Fuel (L)", width: 75 },
    { key: "fuelEfficiencyKmPerL", label: "km/L", width: 65 },
  ],
  "fleet-utilization": [
    { key: "totalActiveVehicles", label: "Active", width: 105 },
    { key: "deployableVehicles", label: "Deployable", width: 105 },
    { key: "vehiclesOnTrip", label: "On Trip", width: 105 },
    { key: "vehiclesInShop", label: "In Shop", width: 105 },
    { key: "fleetUtilizationPercent", label: "Utilization %", width: 105 },
  ],
  "operational-cost": [
    { key: "registrationNo", label: "Reg. No", width: 80 },
    { key: "name", label: "Vehicle", width: 95 },
    { key: "fuelCost", label: "Fuel (Rs)", width: 85 },
    { key: "maintenanceCost", label: "Maint. (Rs)", width: 85 },
    { key: "otherExpenses", label: "Other (Rs)", width: 80 },
    { key: "totalOperationalCost", label: "Total (Rs)", width: 90 },
  ],
  "vehicle-roi": [
    { key: "registrationNo", label: "Reg. No", width: 75 },
    { key: "name", label: "Vehicle", width: 85 },
    { key: "revenue", label: "Revenue", width: 80 },
    { key: "totalCost", label: "Cost", width: 75 },
    { key: "netProfit", label: "Net Profit", width: 80 },
    { key: "roi", label: "ROI", width: 55 },
  ],
  "trip-profitability": [
    { key: "route", label: "Route", width: 125 },
    { key: "registrationNo", label: "Vehicle", width: 75 },
    { key: "distance", label: "Km", width: 55 },
    { key: "revenue", label: "Revenue", width: 75 },
    { key: "totalCost", label: "Cost", width: 70 },
    { key: "margin", label: "Margin", width: 70 },
    { key: "marginPercent", label: "%", width: 45 },
  ],
  "lane-profitability": [
    { key: "route", label: "Lane", width: 150 },
    { key: "trips", label: "Trips", width: 55 },
    { key: "revenue", label: "Revenue", width: 85 },
    { key: "totalCost", label: "Cost", width: 80 },
    { key: "margin", label: "Margin", width: 80 },
    { key: "marginPercent", label: "%", width: 55 },
  ],
};

function drawTable(doc, columns, rows, startY) {
  const startX = doc.page.margins.left;
  const rowHeight = 22;
  let y = startY;

  const drawHeader = () => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111");
    let x = startX;
    columns.forEach((col) => {
      doc.text(col.label, x, y, { width: col.width, align: "left" });
      x += col.width;
    });
    y += rowHeight;
    doc.moveTo(startX, y - 6).lineTo(x, y - 6).strokeColor("#cccccc").stroke();
    doc.font("Helvetica").fontSize(9).fillColor("#333");
  };

  drawHeader();

  if (rows.length === 0) {
    doc.text("No data available for this period.", startX, y);
    return y + rowHeight;
  }

  rows.forEach((row) => {
    if (y > doc.page.height - doc.page.margins.bottom - rowHeight) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader(); // repeat headers on each page
    }
    let colX = startX;
    columns.forEach((col) => {
      const raw = row[col.key];
      const value =
        raw == null
          ? "-"
          : typeof raw === "number"
            ? raw.toLocaleString("en-IN")
            : String(raw);
      doc.text(value, colX, y, { width: col.width, align: "left" });
      colX += col.width;
    });
    y += rowHeight;
  });

  return y;
}

export const exportReportPdf = asyncHandler(async (req, res) => {
  const report = req.query.report;
  const builder = resolveBuilder(report);
  const range = dateRange(req.query);
  const data = await builder(range);

  const columns = REPORT_COLUMNS[report];
  const label = REPORT_LABELS[report];

  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "portrait" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${report}-${Date.now()}.pdf"`);

  // A stream error after headers are sent cannot be turned into a JSON error.
  doc.on("error", (err) => {
    console.error("[pdf] generation failed:", err.message);
    res.destroy(err);
  });

  doc.pipe(res);

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text("TransitOps");
  doc.font("Helvetica").fontSize(12).fillColor("#555").text(label);
  doc
    .fontSize(9)
    .fillColor("#999")
    .text(
      `Generated ${new Date().toLocaleString("en-IN")}` +
        (range.from || range.to
          ? ` · ${range.from ? range.from.toLocaleDateString("en-IN") : "start"} – ${range.to ? range.to.toLocaleDateString("en-IN") : "now"}`
          : "")
    );
  doc.moveDown(1.5);

  drawTable(doc, columns, data, doc.y);

  doc.end();
});

export const REPORT_KEYS = Object.keys(REPORT_BUILDERS);
