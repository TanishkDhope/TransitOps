// Populates the DB with demo vehicles, drivers, customers, trips, fuel logs and
// expenses. Everything is upserted on a natural key, so the script is safe to
// re-run — trips previously had no unique key and duplicated on every run.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const VEHICLES = [
  { registrationNo: "MH-12-AB-1234", name: "Tata Prima 4928",   type: "Truck", maxLoadKg: 28000, odometer: 145230, acquisitionCost: 2500000, region: "West",    status: "AVAILABLE", serviceIntervalKm: 15000, lastServiceOdometer: 140000 },
  { registrationNo: "DL-01-CD-5678", name: "Ashok Leyland 12M", type: "Bus",   maxLoadKg: 16000, odometer: 230450, acquisitionCost: 4200000, region: "North",   status: "AVAILABLE", serviceIntervalKm: 20000, lastServiceOdometer: 228000 },
  { registrationNo: "KA-05-EF-9012", name: "Mahindra Supro",    type: "Van",   maxLoadKg: 1000,  odometer: 78450,  acquisitionCost: 750000,  region: "South",   status: "AVAILABLE", serviceIntervalKm: 10000, lastServiceOdometer: 72000 },
  { registrationNo: "TN-09-GH-3456", name: "Eicher Pro 3019",   type: "Truck", maxLoadKg: 19000, odometer: 312000, acquisitionCost: 3100000, region: "South",   status: "IN_SHOP",   serviceIntervalKm: 15000, lastServiceOdometer: 310000 },
  { registrationNo: "RJ-14-IJ-7890", name: "BharatBenz 1617R",  type: "Truck", maxLoadKg: 16500, odometer: 189000, acquisitionCost: 2800000, region: "West",    status: "AVAILABLE", serviceIntervalKm: 15000, lastServiceOdometer: 180000 },
  { registrationNo: "GJ-06-KL-2345", name: "Tata Winger",       type: "Van",   maxLoadKg: 1500,  odometer: 56000,  acquisitionCost: 950000,  region: "West",    status: "AVAILABLE", serviceIntervalKm: 10000, lastServiceOdometer: 50000 },
  { registrationNo: "UP-32-MN-6789", name: "Volvo B8R",         type: "Bus",   maxLoadKg: 14000, odometer: 420000, acquisitionCost: 8500000, region: "North",   status: "AVAILABLE", serviceIntervalKm: 20000, lastServiceOdometer: 405000 },
  { registrationNo: "MP-09-QR-3344", name: "Tata Ace Gold",     type: "Van",   maxLoadKg: 750,   odometer: 92000,  acquisitionCost: 450000,  region: "Central", status: "AVAILABLE", serviceIntervalKm: 10000, lastServiceOdometer: 90000 },
];

const DRIVERS = [
  { name: "Rajesh Kumar",   email: "rajesh.kumar@transitops-drivers.com",   licenseNumber: "DL-0420110012345", licenseCategory: "HMV",       licenseExpiry: "2027-03-15", contactNumber: "+91-9876543210", status: "AVAILABLE" },
  { name: "Suresh Patel",   email: "suresh.patel@transitops-drivers.com",   licenseNumber: "GJ-0620090098765", licenseCategory: "HMV",       licenseExpiry: "2027-08-20", contactNumber: "+91-9123456780", status: "AVAILABLE" },
  { name: "Anil Sharma",    email: "anil.sharma@transitops-drivers.com",    licenseNumber: "RJ-1420150054321", licenseCategory: "Transport", licenseExpiry: "2026-12-01", contactNumber: "+91-8765432190", status: "AVAILABLE" },
  { name: "Mohammad Irfan", email: "mohammad.irfan@transitops-drivers.com", licenseNumber: "UP-3220170011223", licenseCategory: "HMV",       licenseExpiry: "2027-05-10", contactNumber: "+91-7654321098", status: "AVAILABLE" },
  { name: "Vikram Singh",   email: "vikram.singh@transitops-drivers.com",   licenseNumber: "HR-2620160033445", licenseCategory: "HMV",       licenseExpiry: "2026-09-30", contactNumber: "+91-9988776655", status: "AVAILABLE" },
  { name: "Pradeep Nair",   email: "pradeep.nair@transitops-drivers.com",   licenseNumber: "KA-0520180055667", licenseCategory: "LMV",       licenseExpiry: "2027-02-28", contactNumber: "+91-8877665544", status: "OFF_DUTY" },
];

// ISSUES #33 — customers with rate cards, so trip revenue is computed not guessed.
const CUSTOMERS = [
  { name: "Reliance Retail",   email: "logistics@reliance-demo.com", phone: "+91-2266667777", ratePerKm: 42.5, ratePerTonneKm: 1.8 },
  { name: "Amul Dairy",        email: "dispatch@amul-demo.com",      phone: "+91-2712345678", ratePerKm: 38.0, ratePerTonneKm: 2.1 },
  { name: "Flipkart Supply",   email: "fleet@flipkart-demo.com",     phone: "+91-8041234567", ratePerKm: 45.0 },
  { name: "Tata Steel",        email: "transport@tatasteel-demo.com", phone: "+91-6572345678", flatRate: 95000 },
];

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (days) => new Date(Date.now() + days * DAY);

// `key` gives each trip a natural identity so re-running the seed updates
// instead of duplicating. Offsets are relative to "now" so the demo data is
// always current rather than stuck in July 2026.
const TRIPS = [
  { key: "SEED-01", source: "Mumbai",     destination: "Delhi",     vehicleIdx: 1, driverIdx: 1, customerIdx: 0, cargoWeightKg: 12000, plannedDistance: 1400, status: "DISPATCHED", startOffset: -1, durationH: 36, revenue: 85000 },
  { key: "SEED-02", source: "Bangalore",  destination: "Chennai",   vehicleIdx: 6, driverIdx: 3, customerIdx: 2, cargoWeightKg: 10000, plannedDistance: 350,  status: "DISPATCHED", startOffset: -0.5, durationH: 10, revenue: 32000 },
  { key: "SEED-03", source: "Pune",       destination: "Nagpur",    vehicleIdx: 0, driverIdx: 2, customerIdx: 1, cargoWeightKg: 5000,  plannedDistance: 720,  status: "DRAFT",      startOffset: 2,  durationH: 18, revenue: null },
  { key: "SEED-04", source: "Jaipur",     destination: "Ahmedabad", vehicleIdx: 4, driverIdx: 4, customerIdx: 0, cargoWeightKg: 8000,  plannedDistance: 660,  status: "DRAFT",      startOffset: 3,  durationH: 17, revenue: null },
  { key: "SEED-05", source: "Delhi",      destination: "Lucknow",   vehicleIdx: 4, driverIdx: 2, customerIdx: 1, cargoWeightKg: 14000, plannedDistance: 550,  status: "COMPLETED",  startOffset: -12, durationH: 14, revenue: 42000, startOdometer: 188000, endOdometer: 188550, fuelConsumedL: 165 },
  { key: "SEED-06", source: "Kolkata",    destination: "Bhopal",    vehicleIdx: 7, driverIdx: 4, customerIdx: 3, cargoWeightKg: 7500,  plannedDistance: 1600, status: "COMPLETED",  startOffset: -20, durationH: 40, revenue: 95000, startOdometer: 91000, endOdometer: 92600, fuelConsumedL: 480 },
  { key: "SEED-07", source: "Hyderabad",  destination: "Mumbai",    vehicleIdx: 0, driverIdx: 0, customerIdx: 0, cargoWeightKg: 20000, plannedDistance: 710,  status: "COMPLETED",  startOffset: -28, durationH: 20, revenue: 55000, startOdometer: 144000, endOdometer: 144710, fuelConsumedL: 210 },
  { key: "SEED-08", source: "Surat",      destination: "Indore",    vehicleIdx: 5, driverIdx: 5, customerIdx: 2, cargoWeightKg: 1200,  plannedDistance: 400,  status: "CANCELLED",  startOffset: -8,  durationH: 10, revenue: null },
  { key: "SEED-09", source: "Chandigarh", destination: "Delhi",     vehicleIdx: 7, driverIdx: 4, customerIdx: 2, cargoWeightKg: 9000,  plannedDistance: 250,  status: "COMPLETED",  startOffset: -35, durationH: 7,  revenue: 18000, startOdometer: 419500, endOdometer: 419750, fuelConsumedL: 95 },
  { key: "SEED-10", source: "Chennai",    destination: "Hyderabad", vehicleIdx: 2, driverIdx: 5, customerIdx: 1, cargoWeightKg: 800,   plannedDistance: 630,  status: "COMPLETED",  startOffset: -42, durationH: 16, revenue: 28000, startOdometer: 77800, endOdometer: 78450, fuelConsumedL: 62 },
];

const FUEL_LOGS = [
  { vehicleIdx: 0, tripKey: "SEED-07", liters: 120, cost: 10800, dayOffset: -28 },
  { vehicleIdx: 1, tripKey: null,      liters: 200, cost: 18000, dayOffset: -2 },
  { vehicleIdx: 4, tripKey: "SEED-05", liters: 150, cost: 13500, dayOffset: -12 },
  { vehicleIdx: 7, tripKey: "SEED-09", liters: 180, cost: 16200, dayOffset: -35 },
  { vehicleIdx: 2, tripKey: "SEED-10", liters: 45,  cost: 4050,  dayOffset: -42 },
  { vehicleIdx: 7, tripKey: "SEED-06", liters: 100, cost: 9000,  dayOffset: -20 },
  { vehicleIdx: 5, tripKey: null,      liters: 60,  cost: 5400,  dayOffset: -5 },
  { vehicleIdx: 3, tripKey: null,      liters: 40,  cost: 3600,  dayOffset: -4 },
];

const EXPENSES = [
  { vehicleIdx: 1, tripKey: "SEED-01", type: "TOLL",    amount: 3500, dayOffset: -1 },
  { vehicleIdx: 1, tripKey: "SEED-01", type: "PARKING", amount: 500,  dayOffset: -1 },
  { vehicleIdx: 6, tripKey: "SEED-02", type: "TOLL",    amount: 1200, dayOffset: 0 },
  { vehicleIdx: 4, tripKey: "SEED-05", type: "TOLL",    amount: 2100, dayOffset: -12 },
  { vehicleIdx: 4, tripKey: "SEED-05", type: "FINE",    amount: 1000, dayOffset: -12, note: "Overspeeding near Agra" },
  { vehicleIdx: 7, tripKey: "SEED-06", type: "TOLL",    amount: 4500, dayOffset: -20 },
  { vehicleIdx: 0, tripKey: "SEED-07", type: "TOLL",    amount: 1800, dayOffset: -28 },
  { vehicleIdx: 2, tripKey: "SEED-10", type: "OTHER",   amount: 2000, dayOffset: -42, note: "Loading assistance" },
];

const MAINTENANCE = [
  { vehicleIdx: 3, description: "Engine Overhaul",  cost: 145000, status: "OPEN",   dayOffset: -3 },
  { vehicleIdx: 0, description: "Oil Change",       cost: 4500,   status: "CLOSED", dayOffset: -30 },
  { vehicleIdx: 4, description: "Brake Service",    cost: 18000,  status: "CLOSED", dayOffset: -45 },
  { vehicleIdx: 6, description: "Tire Replacement", cost: 64000,  status: "CLOSED", dayOffset: -50 },
];

async function seedVehicles() {
  const vehicles = [];
  for (const v of VEHICLES) {
    vehicles.push(
      await prisma.vehicle.upsert({
        where: { registrationNo: v.registrationNo },
        update: {
          serviceIntervalKm: v.serviceIntervalKm,
          lastServiceOdometer: v.lastServiceOdometer,
        },
        create: v,
      })
    );
  }
  console.log(`✔ Vehicles ready: ${vehicles.length}`);
  return vehicles;
}

async function seedDrivers() {
  const drivers = [];
  for (const d of DRIVERS) {
    drivers.push(
      await prisma.driver.upsert({
        where: { licenseNumber: d.licenseNumber },
        update: {},
        create: { ...d, licenseExpiry: new Date(d.licenseExpiry) },
      })
    );
  }
  console.log(`✔ Drivers ready: ${drivers.length}`);
  return drivers;
}

async function seedCustomers() {
  const customers = [];
  for (const c of CUSTOMERS) {
    customers.push(
      await prisma.customer.upsert({ where: { name: c.name }, update: c, create: c })
    );
  }
  console.log(`✔ Customers ready: ${customers.length}`);
  return customers;
}

async function seedTrips(vehicles, drivers, customers) {
  const byKey = new Map();

  for (const t of TRIPS) {
    const plannedStart = daysFromNow(t.startOffset);
    const plannedEnd = new Date(plannedStart.getTime() + t.durationH * 60 * 60 * 1000);

    const data = {
      source: t.source,
      destination: t.destination,
      cargoWeightKg: t.cargoWeightKg,
      plannedDistance: t.plannedDistance,
      status: t.status,
      plannedStart,
      plannedEnd,
      vehicleId: vehicles[t.vehicleIdx].id,
      driverId: drivers[t.driverIdx].id,
      customerId: t.customerIdx != null ? customers[t.customerIdx].id : null,
      revenue: t.revenue,
      startOdometer: t.startOdometer ?? null,
      endOdometer: t.endOdometer ?? null,
      fuelConsumedL: t.fuelConsumedL ?? null,
      dispatchedAt: ["DISPATCHED", "COMPLETED"].includes(t.status) ? plannedStart : null,
      completedAt: t.status === "COMPLETED" ? plannedEnd : null,
      cancelledAt: t.status === "CANCELLED" ? plannedStart : null,
    };

    // Idempotent by (source, destination, plannedStart) — no natural key exists,
    // so match on the tuple that identifies a seeded trip.
    const existing = await prisma.trip.findFirst({
      where: { source: t.source, destination: t.destination, vehicleId: data.vehicleId },
    });

    const trip = existing
      ? await prisma.trip.update({ where: { id: existing.id }, data })
      : await prisma.trip.create({ data });

    byKey.set(t.key, trip);
  }

  console.log(`✔ Trips ready: ${byKey.size}`);
  return byKey;
}

async function seedFuelLogs(vehicles, tripsByKey) {
  await prisma.fuelLog.deleteMany({});
  for (const f of FUEL_LOGS) {
    await prisma.fuelLog.create({
      data: {
        vehicleId: vehicles[f.vehicleIdx].id,
        tripId: f.tripKey ? (tripsByKey.get(f.tripKey)?.id ?? null) : null,
        liters: f.liters,
        cost: f.cost,
        loggedAt: daysFromNow(f.dayOffset),
      },
    });
  }
  console.log(`✔ Fuel logs created: ${FUEL_LOGS.length}`);
}

async function seedExpenses(vehicles, tripsByKey) {
  await prisma.expense.deleteMany({});
  for (const e of EXPENSES) {
    await prisma.expense.create({
      data: {
        vehicleId: vehicles[e.vehicleIdx].id,
        tripId: e.tripKey ? (tripsByKey.get(e.tripKey)?.id ?? null) : null,
        type: e.type,
        amount: e.amount,
        note: e.note ?? null,
        incurredAt: daysFromNow(e.dayOffset),
      },
    });
  }
  console.log(`✔ Expenses created: ${EXPENSES.length}`);
}

async function seedMaintenance(vehicles) {
  await prisma.maintenanceLog.deleteMany({});
  for (const m of MAINTENANCE) {
    const startedAt = daysFromNow(m.dayOffset);
    await prisma.maintenanceLog.create({
      data: {
        vehicleId: vehicles[m.vehicleIdx].id,
        description: m.description,
        cost: m.cost,
        status: m.status,
        startedAt,
        closedAt: m.status === "CLOSED" ? new Date(startedAt.getTime() + 2 * DAY) : null,
      },
    });
  }
  console.log(`✔ Maintenance logs created: ${MAINTENANCE.length}`);
}

/** Reconciles vehicle/driver status with the trips and maintenance just seeded. */
async function reconcileStatuses(vehicles, drivers, tripsByKey) {
  const dispatched = [...tripsByKey.values()].filter((t) => t.status === "DISPATCHED");

  await prisma.vehicle.updateMany({
    where: { id: { in: vehicles.map((v) => v.id) }, status: { not: "RETIRED" } },
    data: { status: "AVAILABLE" },
  });
  await prisma.driver.updateMany({
    where: { id: { in: drivers.map((d) => d.id) }, status: { notIn: ["ARCHIVED", "SUSPENDED"] } },
    data: { status: "AVAILABLE" },
  });

  for (const trip of dispatched) {
    await prisma.vehicle.update({ where: { id: trip.vehicleId }, data: { status: "ON_TRIP" } });
    await prisma.driver.update({ where: { id: trip.driverId }, data: { status: "ON_TRIP" } });
  }

  // Vehicles with an open maintenance job belong in the shop.
  const openJobs = await prisma.maintenanceLog.findMany({
    where: { status: "OPEN" },
    select: { vehicleId: true },
  });
  for (const { vehicleId } of openJobs) {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: "IN_SHOP" } });
  }

  // Pradeep Nair stays off duty, as in the source data.
  await prisma.driver.updateMany({
    where: { licenseNumber: "KA-0520180055667" },
    data: { status: "OFF_DUTY" },
  });

  console.log("✔ Statuses reconciled with seeded trips and maintenance");
}

/** ISSUES #32 — derive every safety score from the records just created. */
async function recomputeSafetyScores() {
  const { refreshAllSafetyScores } = await import("../src/services/safety.service.js");
  const { updated } = await refreshAllSafetyScores();
  console.log(`✔ Safety scores computed for ${updated} driver(s)`);
}

async function main() {
  console.log("Seeding demo data...\n");
  const vehicles = await seedVehicles();
  const drivers = await seedDrivers();
  const customers = await seedCustomers();
  const tripsByKey = await seedTrips(vehicles, drivers, customers);
  await seedFuelLogs(vehicles, tripsByKey);
  await seedExpenses(vehicles, tripsByKey);
  await seedMaintenance(vehicles);
  await reconcileStatuses(vehicles, drivers, tripsByKey);
  await recomputeSafetyScores();
  console.log("\n✅ Seed complete.");
}

main()
  .catch((e) => {
    console.error("\n❌ Seed failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
