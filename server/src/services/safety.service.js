// ISSUES #32 — safetyScore was stored, displayed and colour-coded, but nothing
// ever computed it and no rule ever read it. It is now derived from the driver's
// own record and consumed by the dispatch guard.

import prisma from "../db/prisma.js";

export const SAFETY_RULES = {
  BASE: 100,
  FINE_PENALTY: 8, // per traffic fine on a trip this driver ran
  CANCELLED_TRIP_PENALTY: 3, // per trip cancelled after dispatch
  EXPIRED_LICENSE_PENALTY: 25, // driving on an expired licence
  LICENSE_EXPIRING_PENALTY: 5, // licence expires within 30 days
  COMPLETION_BONUS: 1, // per completed trip
  MAX_COMPLETION_BONUS: 15,
  LOOKBACK_DAYS: 365,
};

/** Below this a dispatcher sees a warning; below BLOCK dispatch is refused. */
export const SAFETY_THRESHOLDS = { WARN: 60, BLOCK: 40 };

/**
 * Recomputes one driver's safety score from primary records.
 * Returns the new score without writing it.
 */
export async function computeSafetyScore(driverId) {
  const since = new Date(Date.now() - SAFETY_RULES.LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, licenseExpiry: true },
  });

  if (!driver) return null;

  const [completedCount, cancelledCount, fineCount] = await Promise.all([
    prisma.trip.count({
      where: { driverId, status: "COMPLETED", completedAt: { gte: since } },
    }),
    // Only cancellations after dispatch count — cancelling a draft costs nothing.
    prisma.trip.count({
      where: { driverId, status: "CANCELLED", dispatchedAt: { not: null }, cancelledAt: { gte: since } },
    }),
    prisma.expense.count({
      where: { type: "FINE", incurredAt: { gte: since }, trip: { driverId } },
    }),
  ]);

  let score = SAFETY_RULES.BASE;

  score -= fineCount * SAFETY_RULES.FINE_PENALTY;
  score -= cancelledCount * SAFETY_RULES.CANCELLED_TRIP_PENALTY;

  const now = new Date();
  const daysToExpiry = Math.ceil((new Date(driver.licenseExpiry) - now) / (1000 * 60 * 60 * 24));
  if (daysToExpiry < 0) {
    score -= SAFETY_RULES.EXPIRED_LICENSE_PENALTY;
  } else if (daysToExpiry <= 30) {
    score -= SAFETY_RULES.LICENSE_EXPIRING_PENALTY;
  }

  score += Math.min(completedCount * SAFETY_RULES.COMPLETION_BONUS, SAFETY_RULES.MAX_COMPLETION_BONUS);

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Recomputes and persists one driver's score. Safe to call after any trip/expense change. */
export async function refreshSafetyScore(driverId) {
  const score = await computeSafetyScore(driverId);
  if (score == null) return null;

  await prisma.driver.update({ where: { id: driverId }, data: { safetyScore: score } });
  return score;
}

/** Recomputes every active driver's score. Used by the manual recalculation endpoint. */
export async function refreshAllSafetyScores() {
  const drivers = await prisma.driver.findMany({
    where: { status: { not: "ARCHIVED" } },
    select: { id: true },
  });

  let updated = 0;
  for (const { id } of drivers) {
    const score = await refreshSafetyScore(id);
    if (score != null) updated += 1;
  }
  return { updated };
}

export default { computeSafetyScore, refreshSafetyScore, refreshAllSafetyScores, SAFETY_THRESHOLDS };
