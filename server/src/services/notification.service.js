import cron from "node-cron";
import prisma from "../db/prisma.js";
import {
  sendEmail,
  licenseExpiryEmail,
  insuranceExpiredEmail,
  pucExpiredEmail,
  serviceDueEmail,
  verifyEmailTransport,
  isEmailEnabled,
} from "./email.service.js";

const EXPIRY_WINDOW_DAYS = 30; // what "expiring soon" means
const SERVICE_WARN_KM = 500; // warn this far before the service interval is reached

/**
 * ISSUES #38 — cooldown between repeat notices for the same subject.
 * Without this the cron re-emailed every driver inside the 30-day window on every
 * tick — roughly 1,440 emails per driver per month.
 */
const COOLDOWN_DAYS = {
  LICENSE_EXPIRY: 7,
  INSURANCE_EXPIRY: 7,
  PUC_EXPIRY: 7,
  SERVICE_DUE: 14,
};

let cronTask = null;

/**
 * True when this recipient has already been notified about this subject inside
 * the cooldown window. Only successful sends count, so a transient SMTP failure
 * does not suppress the retry.
 */
async function isOnCooldown(type, subjectId, recipient) {
  const cooldownDays = COOLDOWN_DAYS[type] ?? 7;
  const since = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);

  const recent = await prisma.notificationLog.findFirst({
    where: { type, subjectId, recipient, success: true, sentAt: { gte: since } },
    select: { id: true },
  });

  return Boolean(recent);
}

/** Sends one notification, honouring the cooldown and recording the outcome. */
async function sendOnce({ type, subjectId, payload }) {
  const recipient = payload.to;

  if (await isOnCooldown(type, subjectId, recipient)) {
    return { skipped: true, reason: "cooldown" };
  }

  const result = await sendEmail(payload);

  await prisma.notificationLog.create({
    data: {
      type,
      subjectId,
      recipient,
      success: result.success,
      error: result.success ? null : String(result.error ?? "").slice(0, 500),
    },
  });

  return { skipped: false, sent: result.success };
}

/** Fleet Managers and Admins receive vehicle-level compliance notices. */
async function getFleetRecipients() {
  const users = await prisma.user.findMany({
    where: { role: { in: ["FLEET_MANAGER", "ADMIN"] } },
    select: { email: true },
  });
  return users.map((u) => u.email).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Driver licences
// ---------------------------------------------------------------------------

export async function checkExpiringLicenses() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const expiringDrivers = await prisma.driver.findMany({
    where: {
      licenseExpiry: { lte: windowEnd },
      status: { notIn: ["SUSPENDED", "ARCHIVED"] },
    },
    select: {
      id: true,
      name: true,
      email: true,
      licenseNumber: true,
      licenseExpiry: true,
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const driver of expiringDrivers) {
    if (!driver.email) {
      console.warn(`[expiry-check] ${driver.name} (${driver.licenseNumber}) has no email — skipped`);
      skipped += 1;
      continue;
    }

    const daysRemaining = Math.ceil((new Date(driver.licenseExpiry) - now) / (1000 * 60 * 60 * 24));
    const result = await sendOnce({
      type: "LICENSE_EXPIRY",
      subjectId: driver.id,
      payload: licenseExpiryEmail(driver, daysRemaining),
    });

    if (result.skipped) skipped += 1;
    else if (result.sent) sent += 1;
  }

  console.log(
    `[expiry-check] licenses — checked ${expiringDrivers.length}, sent ${sent}, skipped ${skipped}`
  );
  return { checked: expiringDrivers.length, sent, skipped };
}

// ---------------------------------------------------------------------------
// Vehicle insurance
// ---------------------------------------------------------------------------

export async function checkVehicleInsurance() {
  const now = new Date();

  const newlyExpired = await prisma.vehicle.findMany({
    where: { insuranceExpiry: { lt: now }, insuranceExpired: false, status: { not: "RETIRED" } },
  });

  let sent = 0;

  if (newlyExpired.length > 0) {
    await prisma.vehicle.updateMany({
      where: { id: { in: newlyExpired.map((v) => v.id) } },
      data: { insuranceExpired: true },
    });

    const recipients = await getFleetRecipients();
    for (const vehicle of newlyExpired) {
      for (const email of recipients) {
        const result = await sendOnce({
          type: "INSURANCE_EXPIRY",
          subjectId: vehicle.id,
          payload: insuranceExpiredEmail(vehicle, email),
        });
        if (!result.skipped && result.sent) sent += 1;
      }
    }
  }

  // Renewal detection — un-flag vehicles whose expiry moved into the future.
  const renewed = await prisma.vehicle.findMany({
    where: { insuranceExpired: true, insuranceExpiry: { gte: now } },
    select: { id: true },
  });

  if (renewed.length > 0) {
    await prisma.vehicle.updateMany({
      where: { id: { in: renewed.map((v) => v.id) } },
      data: { insuranceExpired: false },
    });
  }

  console.log(
    `[insurance-check] flagged ${newlyExpired.length}, un-flagged ${renewed.length}, sent ${sent}`
  );
  return { flagged: newlyExpired.length, unflagged: renewed.length, sent };
}

// ---------------------------------------------------------------------------
// Vehicle PUC — ISSUES #34 (previously captured but never checked)
// ---------------------------------------------------------------------------

export async function checkVehiclePuc() {
  const now = new Date();

  const newlyExpired = await prisma.vehicle.findMany({
    where: { pucExpiry: { lt: now }, pucExpired: false, status: { not: "RETIRED" } },
  });

  let sent = 0;

  if (newlyExpired.length > 0) {
    await prisma.vehicle.updateMany({
      where: { id: { in: newlyExpired.map((v) => v.id) } },
      data: { pucExpired: true },
    });

    const recipients = await getFleetRecipients();
    for (const vehicle of newlyExpired) {
      for (const email of recipients) {
        const result = await sendOnce({
          type: "PUC_EXPIRY",
          subjectId: vehicle.id,
          payload: pucExpiredEmail(vehicle, email),
        });
        if (!result.skipped && result.sent) sent += 1;
      }
    }
  }

  const renewed = await prisma.vehicle.findMany({
    where: { pucExpired: true, pucExpiry: { gte: now } },
    select: { id: true },
  });

  if (renewed.length > 0) {
    await prisma.vehicle.updateMany({
      where: { id: { in: renewed.map((v) => v.id) } },
      data: { pucExpired: false },
    });
  }

  console.log(`[puc-check] flagged ${newlyExpired.length}, un-flagged ${renewed.length}, sent ${sent}`);
  return { flagged: newlyExpired.length, unflagged: renewed.length, sent };
}

// ---------------------------------------------------------------------------
// Preventive service — ISSUES #34
// ---------------------------------------------------------------------------

/** Vehicles whose odometer has reached (or nearly reached) their service interval. */
export async function checkServiceDue() {
  const vehicles = await prisma.vehicle.findMany({
    where: { serviceIntervalKm: { not: null }, status: { notIn: ["RETIRED", "IN_SHOP"] } },
  });

  const due = vehicles.filter((v) => {
    const nextServiceAt = v.lastServiceOdometer + v.serviceIntervalKm;
    return v.odometer >= nextServiceAt - SERVICE_WARN_KM;
  });

  let sent = 0;

  if (due.length > 0) {
    const recipients = await getFleetRecipients();
    for (const vehicle of due) {
      const kmOverdue = vehicle.odometer - (vehicle.lastServiceOdometer + vehicle.serviceIntervalKm);
      for (const email of recipients) {
        const result = await sendOnce({
          type: "SERVICE_DUE",
          subjectId: vehicle.id,
          payload: serviceDueEmail(vehicle, kmOverdue, email),
        });
        if (!result.skipped && result.sent) sent += 1;
      }
    }
  }

  console.log(`[service-check] ${due.length} vehicle(s) due, sent ${sent}`);
  return { due: due.length, sent };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runAllChecks() {
  const [licenses, insurance, puc, service] = await Promise.all([
    checkExpiringLicenses(),
    checkVehicleInsurance(),
    checkVehiclePuc(),
    checkServiceDue(),
  ]);
  return { licenses, insurance, puc, service };
}

const CRON_EXPRESSION = "*/30 * * * *"; // every 30 minutes

export function startExpiryCron() {
  if (!isEmailEnabled()) {
    console.warn("⚠  Expiry cron not started — email integration is not configured");
    return;
  }

  verifyEmailTransport().then((ok) => {
    if (!ok) {
      console.warn("⚠  Expiry cron started, but SMTP verification failed — sends may not deliver");
    }
  });

  // One immediate pass so a fresh start surfaces problems without a 30-minute wait.
  runAllChecks().catch((err) => console.error("[expiry-check] initial run failed:", err.message));

  cronTask = cron.schedule(CRON_EXPRESSION, () => {
    console.log("[expiry-check] running scheduled checks...");
    runAllChecks().catch((err) => console.error("[expiry-check] scheduled run failed:", err.message));
  });

  console.log(`✅ Expiry cron started (${CRON_EXPRESSION}, plus one run on startup)`);
}

export function stopExpiryCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}

export default { startExpiryCron, stopExpiryCron, runAllChecks };
