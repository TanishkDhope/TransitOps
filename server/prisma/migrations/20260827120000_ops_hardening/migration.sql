-- ============================================================================
--  Ops hardening migration
--  · username uniqueness            (ISSUES #8)
--  · driver soft-delete status      (ISSUES #27)
--  · PUC expiry tracking            (ISSUES #34)
--  · preventive service scheduling  (ISSUES #34)
--  · trip scheduling window         (ISSUES #31)
--  · customers + rate cards         (ISSUES #33)
--  · audit trail                    (ISSUES #36)
--  · notification delivery log      (ISSUES #38)
-- ============================================================================

-- ---------- enums ----------
ALTER TYPE "DriverStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM ('LICENSE_EXPIRY', 'INSURANCE_EXPIRY', 'PUC_EXPIRY', 'SERVICE_DUE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- User.username unique (#8) ----------
-- De-duplicate defensively before adding the constraint: keep the oldest row's
-- username, suffix any later collisions with a short slice of their id.
UPDATE "User" u
SET "username" = u."username" || '-' || substr(u."id", 1, 4)
WHERE EXISTS (
  SELECT 1 FROM "User" o
  WHERE o."username" = u."username"
    AND o."createdAt" < u."createdAt"
);

CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");

-- ---------- Vehicle: PUC flag + service schedule (#34) ----------
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "pucExpired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "serviceIntervalKm" DOUBLE PRECISION;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "lastServiceOdometer" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Seed the flag from existing data so the cron does not treat every already
-- expired vehicle as "newly expired" and email about all of them at once.
UPDATE "Vehicle"
SET "pucExpired" = true
WHERE "pucExpiry" IS NOT NULL AND "pucExpiry" < NOW();

-- ---------- Customer + rate card (#33) ----------
CREATE TABLE IF NOT EXISTS "Customer" (
    "id"             TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "email"          TEXT,
    "phone"          TEXT,
    "ratePerKm"      DECIMAL(10,2),
    "ratePerTonneKm" DECIMAL(10,2),
    "flatRate"       DECIMAL(12,2),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_name_key" ON "Customer"("name");

-- ---------- Trip: customer + scheduling window (#31, #33) ----------
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "plannedStart" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "plannedEnd" TIMESTAMP(3);

-- Backfill existing rows before making the columns NOT NULL.
-- Best available signal, in order: dispatch/completion timestamps, else createdAt.
-- Window length is derived from plannedDistance at a conservative 40 km/h average.
UPDATE "Trip"
SET "plannedStart" = COALESCE("dispatchedAt", "createdAt")
WHERE "plannedStart" IS NULL;

UPDATE "Trip"
SET "plannedEnd" = COALESCE(
      "completedAt",
      "cancelledAt",
      "plannedStart" + make_interval(hours => GREATEST(CEIL("plannedDistance" / 40.0), 1)::int)
    )
WHERE "plannedEnd" IS NULL;

-- Guarantee end > start even if historic timestamps were inconsistent.
UPDATE "Trip"
SET "plannedEnd" = "plannedStart" + INTERVAL '1 hour'
WHERE "plannedEnd" <= "plannedStart";

ALTER TABLE "Trip" ALTER COLUMN "plannedStart" SET NOT NULL;
ALTER TABLE "Trip" ALTER COLUMN "plannedEnd" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "Trip" ADD CONSTRAINT "Trip_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Trip_vehicleId_plannedStart_plannedEnd_idx"
  ON "Trip"("vehicleId", "plannedStart", "plannedEnd");
CREATE INDEX IF NOT EXISTS "Trip_driverId_plannedStart_plannedEnd_idx"
  ON "Trip"("driverId", "plannedStart", "plannedEnd");

-- ---------- FuelLog / Expense: index the trip link (#35) ----------
CREATE INDEX IF NOT EXISTS "FuelLog_tripId_idx" ON "FuelLog"("tripId");
CREATE INDEX IF NOT EXISTS "Expense_tripId_idx" ON "Expense"("tripId");

-- ---------- AuditLog (#36) ----------
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id"         TEXT NOT NULL,
    "actorId"    TEXT,
    "actorEmail" TEXT,
    "entity"     TEXT NOT NULL,
    "entityId"   TEXT NOT NULL,
    "action"     TEXT NOT NULL,
    "summary"    TEXT,
    "before"     JSONB,
    "after"      JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"       ON "AuditLog"("createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_actorId_idx"         ON "AuditLog"("actorId");

DO $$ BEGIN
  ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- NotificationLog (#38) ----------
CREATE TABLE IF NOT EXISTS "NotificationLog" (
    "id"        TEXT NOT NULL,
    "type"      "NotificationType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "success"   BOOLEAN NOT NULL DEFAULT true,
    "error"     TEXT,
    "sentAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NotificationLog_type_subjectId_sentAt_idx"
  ON "NotificationLog"("type", "subjectId", "sentAt");
CREATE INDEX IF NOT EXISTS "NotificationLog_recipient_idx" ON "NotificationLog"("recipient");
