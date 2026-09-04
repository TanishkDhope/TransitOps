import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { extractLicenseDetails } from "../services/license.service.js";
import { uploadImageBuffers, isCloudinaryEnabled } from "../services/cloudinary.service.js";
import { isGeminiEnabled } from "../services/gemini.client.js";
import { refreshSafetyScore, refreshAllSafetyScores } from "../services/safety.service.js";
import { badRequest, notFound, conflict, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toDate, toEnum, toFiniteNumber, validateEmail, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { auditOp, writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

const LICENSE_CATEGORIES = ["HMV", "LMV", "Transport"];
const ASSIGNABLE_STATUSES = ["AVAILABLE", "OFF_DUTY"];

function matchLicenseCategory(categories) {
  if (!Array.isArray(categories)) return null;
  for (const category of categories) {
    const match = LICENSE_CATEGORIES.find(
      (valid) => valid.toLowerCase() === String(category).trim().toLowerCase()
    );
    if (match) return match;
  }
  return null;
}

/**
 * ISSUES #5 — the licence images are now uploaded to Cloudinary and their URLs
 * returned, so `licenseFrontUrl` / `licenseBackUrl` can actually be populated.
 * Previously the buffers were sent to Gemini and then discarded, leaving those
 * columns permanently NULL while the equivalent vehicle flow stored its images.
 */
export const extractDriverLicense = asyncHandler(async (req, res) => {
  const frontFile = req.files?.frontImage?.[0];
  const backFile = req.files?.backImage?.[0];

  if (!frontFile || !backFile) {
    throw badRequest("Please upload both the front and back of the licence.");
  }

  if (!isGeminiEnabled() && !isCloudinaryEnabled()) {
    throw badRequest(
      "Licence scanning and upload are not configured on this server. Please enter the details manually.",
      ERROR_CODES.INTEGRATION_DISABLED
    );
  }

  // Same fault-tolerance contract as the vehicle document flow (ISSUES #3):
  // a failure in either half must not discard the other half's result.
  const [extracted, uploadResult] = await Promise.all([
    isGeminiEnabled()
      ? extractLicenseDetails(frontFile.buffer, backFile.buffer, {
          frontMimeType: frontFile.mimetype,
          backMimeType: backFile.mimetype,
        }).catch((err) => {
          console.error("[license] extraction failed:", err.message);
          return null;
        })
      : Promise.resolve(null),
    uploadImageBuffers([frontFile.buffer, backFile.buffer], { folder: "transitops/licenses" }),
  ]);

  const extractionFailed = !extracted;
  const [licenseFrontUrl = null, licenseBackUrl = null] = uploadResult.urls;

  let message = "Details extracted — please review them before saving.";
  if (extractionFailed && uploadResult.failed > 0) {
    message = "Scanning and upload both failed. Please enter the details manually.";
  } else if (extractionFailed) {
    message = "Images uploaded, but the details could not be read. Please fill them in manually.";
  } else if (uploadResult.failed > 0) {
    message = "Details extracted, but the licence images could not be stored.";
  }

  return res.status(200).json({
    success: true,
    extractionFailed,
    uploadFailed: uploadResult.failed > 0,
    uploadsDisabled: uploadResult.disabled,
    message,
    data: {
      name: extracted?.name ?? "",
      licenseNumber: extracted?.licenseNumber ?? "",
      licenseCategory: matchLicenseCategory(extracted?.licenseCategory),
      licenseExpiry: extracted?.licenseExpiry ?? "",
      dateOfBirth: extracted?.dateOfBirth ?? "",
      address: extracted?.address ?? "",
      bloodGroup: extracted?.bloodGroup ?? "",
      licenseFrontUrl,
      licenseBackUrl,
    },
  });
});

export const createDriver = asyncHandler(async (req, res) => {
  requireFields(req.body, [
    "name",
    "email",
    "licenseNumber",
    "licenseCategory",
    "licenseExpiry",
    "contactNumber",
  ]);

  const {
    name,
    email,
    licenseNumber,
    licenseCategory,
    licenseExpiry,
    contactNumber,
    licenseFrontUrl,
    licenseBackUrl,
    userId,
  } = req.body;

  const emailError = validateEmail(email);
  if (emailError) throw badRequest(emailError, ERROR_CODES.VALIDATION_FAILED, { fields: ["email"] });

  toEnum(licenseCategory, LICENSE_CATEGORIES, "licenseCategory");

  const parsedExpiry = toDate(licenseExpiry, "licenseExpiry");
  if (parsedExpiry <= new Date()) {
    throw badRequest(
      "The licence expiry date is in the past. A driver cannot be added with an expired licence.",
      ERROR_CODES.LICENSE_EXPIRED,
      { fields: ["licenseExpiry"] }
    );
  }

  if (userId) {
    const linkedUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!linkedUser) throw notFound("Linked user account");
  }

  const driver = await prisma.driver.create({
    data: {
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      licenseNumber: String(licenseNumber).trim().toUpperCase(),
      licenseCategory,
      licenseExpiry: parsedExpiry,
      contactNumber: String(contactNumber).trim(),
      // ISSUES #32 — safetyScore is derived, never accepted from the client.
      safetyScore: 100,
      ...(licenseFrontUrl ? { licenseFrontUrl } : {}),
      ...(licenseBackUrl ? { licenseBackUrl } : {}),
      ...(userId ? { userId } : {}),
    },
  });

  await refreshSafetyScore(driver.id);
  await writeAudit({
    actor: req.user,
    entity: "Driver",
    entityId: driver.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Added driver ${driver.name} (${driver.licenseNumber})`,
    after: driver,
  });

  const created = await prisma.driver.findUnique({ where: { id: driver.id } });

  return res.status(201).json({
    success: true,
    message: `Driver ${created.name} added`,
    data: created,
  });
});

export const getDrivers = asyncHandler(async (req, res) => {
  const { status, licenseCategory, search, includeArchived } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(status ? { status } : {}),
    ...(licenseCategory ? { licenseCategory } : {}),
    // Archived drivers are hidden by default but stay queryable for history.
    ...(includeArchived === "true" ? {} : { status: { not: "ARCHIVED" } }),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { licenseNumber: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [drivers, total] = await Promise.all([
    prisma.driver.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.driver.count({ where }),
  ]);

  return paginated(res, drivers, total, pagination);
});

export const getDriverById = asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { trips: true } },
      trips: {
        orderBy: { plannedStart: "desc" },
        take: 5,
        select: {
          id: true,
          source: true,
          destination: true,
          status: true,
          plannedStart: true,
        },
      },
    },
  });

  if (!driver) throw notFound("Driver");

  return res.status(200).json({ success: true, data: driver });
});

export const updateDriver = asyncHandler(async (req, res) => {
  const { name, email, licenseNumber, licenseCategory, licenseExpiry, contactNumber, licenseFrontUrl, licenseBackUrl } =
    req.body;

  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) throw notFound("Driver");

  if (driver.status === "ARCHIVED") {
    throw badRequest(
      `${driver.name} is archived. Restore the driver before editing their details.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  const data = {};

  if (name !== undefined) data.name = String(name).trim();
  if (email !== undefined) {
    const emailError = validateEmail(email);
    if (emailError) throw badRequest(emailError, ERROR_CODES.VALIDATION_FAILED, { fields: ["email"] });
    data.email = String(email).trim().toLowerCase();
  }
  if (licenseNumber !== undefined) data.licenseNumber = String(licenseNumber).trim().toUpperCase();
  if (licenseCategory !== undefined) {
    data.licenseCategory = toEnum(licenseCategory, LICENSE_CATEGORIES, "licenseCategory");
  }
  if (licenseExpiry !== undefined) data.licenseExpiry = toDate(licenseExpiry, "licenseExpiry");
  if (contactNumber !== undefined) data.contactNumber = String(contactNumber).trim();
  if (licenseFrontUrl !== undefined) data.licenseFrontUrl = licenseFrontUrl || null;
  if (licenseBackUrl !== undefined) data.licenseBackUrl = licenseBackUrl || null;

  // ISSUES #32 — safetyScore is intentionally NOT accepted here. It is derived.

  if (Object.keys(data).length === 0) {
    throw badRequest("No changes were provided.");
  }

  const updated = await prisma.driver.update({ where: { id: req.params.id }, data });

  // A licence expiry change moves the score, so recompute immediately.
  if (data.licenseExpiry) await refreshSafetyScore(updated.id);

  await writeAudit({
    actor: req.user,
    entity: "Driver",
    entityId: updated.id,
    action: AUDIT_ACTIONS.UPDATE,
    summary: `Updated driver ${updated.name}`,
    before: driver,
    after: updated,
  });

  const fresh = await prisma.driver.findUnique({ where: { id: updated.id } });

  return res.status(200).json({
    success: true,
    message: `Driver ${fresh.name} updated`,
    data: fresh,
  });
});

export const suspendDriver = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) throw notFound("Driver");

  if (driver.status === "SUSPENDED") {
    throw badRequest(`${driver.name} is already suspended.`, ERROR_CODES.ILLEGAL_TRANSITION);
  }
  if (driver.status === "ON_TRIP") {
    throw conflict(
      `${driver.name} is currently on a trip and cannot be suspended.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (driver.status === "ARCHIVED") {
    throw badRequest(`${driver.name} is archived.`, ERROR_CODES.ILLEGAL_TRANSITION);
  }

  const [updated] = await prisma.$transaction([
    prisma.driver.update({ 
      where: { id: req.params.id }, 
      data: { status: "SUSPENDED", suspensionReason: reason || "No reason provided" } 
    }),
    auditOp({
      actor: req.user,
      entity: "Driver",
      entityId: driver.id,
      action: AUDIT_ACTIONS.SUSPEND,
      summary: `Suspended driver ${driver.name}${req.body?.reason ? ` — ${req.body.reason}` : ""}`,
      before: { status: driver.status },
      after: { status: "SUSPENDED" },
    }),
  ]);

  return res.status(200).json({
    success: true,
    message: `${updated.name} has been suspended`,
    data: updated,
  });
});

/**
 * ISSUES #10 — there was previously no way back from SUSPENDED, and nothing ever
 * set OFF_DUTY, so a driver could never be marked temporarily unavailable.
 * This endpoint owns every manual status transition.
 */
export const updateDriverStatus = asyncHandler(async (req, res) => {
  requireFields(req.body, ["status"]);
  const status = toEnum(req.body.status, [...ASSIGNABLE_STATUSES, "SUSPENDED"], "status");

  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) throw notFound("Driver");

  if (driver.status === "ON_TRIP") {
    throw conflict(
      `${driver.name} is currently on a trip. Complete or cancel the trip first.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (driver.status === "ARCHIVED") {
    throw badRequest(
      `${driver.name} is archived. Restore the driver first.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }
  if (driver.status === status) {
    throw badRequest(`${driver.name} is already ${status.replace("_", " ").toLowerCase()}.`, ERROR_CODES.ILLEGAL_TRANSITION);
  }

  // Returning to duty requires a valid licence.
  if (status === "AVAILABLE" && new Date(driver.licenseExpiry) <= new Date()) {
    throw badRequest(
      `${driver.name}'s licence expired on ${new Date(driver.licenseExpiry).toLocaleDateString("en-IN")}. Update it before returning them to duty.`,
      ERROR_CODES.LICENSE_EXPIRED
    );
  }

  const isReinstatement = driver.status === "SUSPENDED" && status === "AVAILABLE";

  const [updated] = await prisma.$transaction([
    prisma.driver.update({ where: { id: req.params.id }, data: { status, suspensionReason: status === "SUSPENDED" ? req.body.reason || "No reason provided" : null } }),
    auditOp({
      actor: req.user,
      entity: "Driver",
      entityId: driver.id,
      action: isReinstatement ? AUDIT_ACTIONS.REINSTATE : AUDIT_ACTIONS.STATUS_CHANGE,
      summary: `${driver.name}: ${driver.status} → ${status}${req.body?.reason ? ` — ${req.body.reason}` : ""}`,
      before: { status: driver.status },
      after: { status },
    }),
  ]);

  const labels = {
    AVAILABLE: "returned to duty",
    OFF_DUTY: "marked off duty",
    SUSPENDED: "suspended",
  };

  return res.status(200).json({
    success: true,
    message: `${updated.name} has been ${labels[status]}`,
    data: updated,
  });
});

/**
 * ISSUES #27 — drivers are now archived, not hard-deleted.
 * A hard delete threw an opaque foreign-key 500 for any driver with trip history,
 * and would have destroyed that history if it had succeeded.
 */
export const deleteDriver = asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { trips: true } } },
  });

  if (!driver) throw notFound("Driver");

  if (driver.status === "ON_TRIP") {
    throw conflict(
      `${driver.name} is currently on a trip and cannot be removed.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }
  if (driver.status === "ARCHIVED") {
    throw badRequest(`${driver.name} is already archived.`, ERROR_CODES.ILLEGAL_TRANSITION);
  }

  const upcoming = await prisma.trip.count({
    where: { driverId: driver.id, status: { in: ["DRAFT", "DISPATCHED"] } },
  });

  if (upcoming > 0) {
    throw conflict(
      `${driver.name} has ${upcoming} scheduled trip(s). Cancel or reassign them first.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }

  // No trip history at all → nothing to preserve, so a real delete is safe.
  if (driver._count.trips === 0) {
    await prisma.$transaction([
      prisma.driver.delete({ where: { id: driver.id } }),
      auditOp({
        actor: req.user,
        entity: "Driver",
        entityId: driver.id,
        action: AUDIT_ACTIONS.DELETE,
        summary: `Deleted driver ${driver.name} (no trip history)`,
        before: driver,
      }),
    ]);

    return res.status(200).json({
      success: true,
      message: `${driver.name} has been removed`,
      data: { id: driver.id, deleted: true },
    });
  }

  const [updated] = await prisma.$transaction([
    prisma.driver.update({ where: { id: driver.id }, data: { status: "ARCHIVED" } }),
    auditOp({
      actor: req.user,
      entity: "Driver",
      entityId: driver.id,
      action: AUDIT_ACTIONS.ARCHIVE,
      summary: `Archived driver ${driver.name} (${driver._count.trips} trip(s) preserved)`,
      before: { status: driver.status },
      after: { status: "ARCHIVED" },
    }),
  ]);

  return res.status(200).json({
    success: true,
    message: `${updated.name} archived — their ${driver._count.trips} trip record(s) were kept`,
    data: updated,
  });
});

/** Restores an archived driver. */
export const restoreDriver = asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) throw notFound("Driver");

  if (driver.status !== "ARCHIVED") {
    throw badRequest(`${driver.name} is not archived.`, ERROR_CODES.ILLEGAL_TRANSITION);
  }

  const licenceValid = new Date(driver.licenseExpiry) > new Date();

  const [updated] = await prisma.$transaction([
    prisma.driver.update({
      where: { id: driver.id },
      data: { status: licenceValid ? "AVAILABLE" : "OFF_DUTY" },
    }),
    auditOp({
      actor: req.user,
      entity: "Driver",
      entityId: driver.id,
      action: AUDIT_ACTIONS.REINSTATE,
      summary: `Restored driver ${driver.name}`,
      before: { status: "ARCHIVED" },
      after: { status: licenceValid ? "AVAILABLE" : "OFF_DUTY" },
    }),
  ]);

  await refreshSafetyScore(updated.id);

  return res.status(200).json({
    success: true,
    message: licenceValid
      ? `${updated.name} restored and available`
      : `${updated.name} restored, but their licence has expired — marked off duty`,
    data: updated,
  });
});

/** ISSUES #32 — recomputes every driver's safety score from primary records. */
export const recalculateSafetyScores = asyncHandler(async (req, res) => {
  const { updated } = await refreshAllSafetyScores();

  return res.status(200).json({
    success: true,
    message: `Recalculated safety scores for ${updated} driver(s)`,
    data: { updated },
  });
});
