import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { extractVehicleDocumentDetails, EMPTY_VEHICLE_EXTRACTION } from "../services/vehicleDocument.service.js";
import { uploadImageBuffers, isCloudinaryEnabled } from "../services/cloudinary.service.js";
import { isGeminiEnabled } from "../services/gemini.client.js";
import { badRequest, notFound, conflict, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, toDate, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { auditOp, writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

const VEHICLE_STATUSES = ["AVAILABLE", "ON_TRIP", "IN_SHOP", "RETIRED"];

/**
 * ISSUES #3 — extraction and upload are now independently fault-tolerant.
 * Previously the unguarded `Promise.all` around the uploads rejected the whole
 * request, throwing away a successful extraction and 500-ing the endpoint.
 */
export const extractVehicleDocuments = asyncHandler(async (req, res) => {
  const files = req.files || [];

  if (files.length === 0) {
    throw badRequest("Please choose at least one document image to scan.");
  }

  if (!isGeminiEnabled() && !isCloudinaryEnabled()) {
    throw badRequest(
      "Document scanning and upload are not configured on this server. Please enter the details manually.",
      ERROR_CODES.INTEGRATION_DISABLED
    );
  }

  const [extractedResult, uploadResult] = await Promise.all([
    isGeminiEnabled()
      ? extractVehicleDocumentDetails(files).catch((err) => {
          console.error("[vehicle-docs] extraction failed:", err.message);
          return null;
        })
      : Promise.resolve(null),
    uploadImageBuffers(
      files.map((file) => file.buffer),
      { folder: "transitops/vehicle-documents" }
    ),
  ]);

  const extractionFailed = !extractedResult;
  const uploadFailed = uploadResult.failed > 0;

  let message = "Details extracted — please review them before saving.";
  if (extractionFailed && uploadFailed) {
    message = "Scanning and upload both failed. Please enter the details manually.";
  } else if (extractionFailed) {
    message = "Images uploaded, but the details could not be read. Please fill them in manually.";
  } else if (uploadFailed) {
    message = `Details extracted, but ${uploadResult.failed} image(s) could not be uploaded.`;
  }

  return res.status(200).json({
    success: true,
    extractionFailed,
    uploadFailed,
    uploadsDisabled: uploadResult.disabled,
    message,
    data: {
      ...(extractedResult || EMPTY_VEHICLE_EXTRACTION),
      documentUrls: uploadResult.urls,
    },
  });
});

export const createVehicle = asyncHandler(async (req, res) => {
  requireFields(req.body, ["registrationNo", "name", "type"]);

  const {
    registrationNo,
    name,
    type,
    maxLoadKg,
    odometer,
    acquisitionCost,
    region,
    rcNumber,
    insuranceNumber,
    insuranceExpiry,
    pucNumber,
    pucExpiry,
    documentUrls,
    serviceIntervalKm,
    lastServiceOdometer,
  } = req.body;

  // ISSUES #20 — `!value` rejected legitimate zeros (a leased vehicle with no
  // acquisition cost, a car with no rated cargo load). Presence and numeric
  // validity are now checked separately.
  if (isMissing(maxLoadKg)) {
    throw badRequest("maxLoadKg is required", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["maxLoadKg"],
    });
  }
  if (isMissing(acquisitionCost)) {
    throw badRequest("acquisitionCost is required", ERROR_CODES.VALIDATION_FAILED, {
      fields: ["acquisitionCost"],
    });
  }

  const parsedMaxLoad = toFiniteNumber(maxLoadKg, "maxLoadKg", { min: 0 });
  const parsedCost = toFiniteNumber(acquisitionCost, "acquisitionCost", { min: 0 });
  const parsedOdometer = isMissing(odometer) ? 0 : toFiniteNumber(odometer, "odometer", { min: 0 });

  const now = new Date();
  const parsedInsuranceExpiry = isMissing(insuranceExpiry)
    ? null
    : toDate(insuranceExpiry, "insuranceExpiry");
  const parsedPucExpiry = isMissing(pucExpiry) ? null : toDate(pucExpiry, "pucExpiry");

  const vehicle = await prisma.vehicle.create({
    data: {
      registrationNo: String(registrationNo).trim().toUpperCase(),
      name: String(name).trim(),
      type: String(type).trim(),
      maxLoadKg: parsedMaxLoad,
      odometer: parsedOdometer,
      acquisitionCost: parsedCost,
      ...(isMissing(region) ? {} : { region }),
      ...(isMissing(rcNumber) ? {} : { rcNumber }),
      ...(isMissing(insuranceNumber) ? {} : { insuranceNumber }),
      ...(parsedInsuranceExpiry
        ? { insuranceExpiry: parsedInsuranceExpiry, insuranceExpired: parsedInsuranceExpiry < now }
        : {}),
      ...(isMissing(pucNumber) ? {} : { pucNumber }),
      ...(parsedPucExpiry
        ? { pucExpiry: parsedPucExpiry, pucExpired: parsedPucExpiry < now }
        : {}),
      ...(Array.isArray(documentUrls) && documentUrls.length > 0 ? { documentUrls } : {}),
      // ISSUES #34 — preventive service scheduling
      ...(isMissing(serviceIntervalKm)
        ? {}
        : { serviceIntervalKm: toFiniteNumber(serviceIntervalKm, "serviceIntervalKm", { min: 1 }) }),
      lastServiceOdometer: isMissing(lastServiceOdometer)
        ? parsedOdometer
        : toFiniteNumber(lastServiceOdometer, "lastServiceOdometer", { min: 0 }),
    },
  });

  await writeAudit({
    actor: req.user,
    entity: "Vehicle",
    entityId: vehicle.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Registered vehicle ${vehicle.registrationNo}`,
    after: vehicle,
  });

  return res.status(201).json({
    success: true,
    message: `Vehicle ${vehicle.registrationNo} added to the fleet`,
    data: vehicle,
  });
});

export const getVehicles = asyncHandler(async (req, res) => {
  const { status, type, region, search, includeRetired } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(region ? { region } : {}),
    ...(includeRetired === "false" ? { status: { not: "RETIRED" } } : {}),
    ...(search
      ? {
          OR: [
            { registrationNo: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [vehicles, total] = await Promise.all([
    prisma.vehicle.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.vehicle.count({ where }),
  ]);

  return paginated(res, vehicles, total, pagination);
});

export const getVehicleById = asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: req.params.id },
    include: {
      maintenanceLogs: { orderBy: { startedAt: "desc" }, take: 5 },
      _count: { select: { trips: true, fuelLogs: true, expenses: true } },
    },
  });

  if (!vehicle) throw notFound("Vehicle");

  return res.status(200).json({ success: true, data: vehicle });
});

export const updateVehicle = asyncHandler(async (req, res) => {
  const {
    name,
    type,
    maxLoadKg,
    region,
    odometer,
    acquisitionCost,
    rcNumber,
    insuranceNumber,
    insuranceExpiry,
    pucNumber,
    pucExpiry,
    documentUrls,
    serviceIntervalKm,
    lastServiceOdometer,
  } = req.body;

  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!vehicle) throw notFound("Vehicle");

  if (vehicle.status === "RETIRED") {
    throw badRequest(
      "This vehicle is retired and can no longer be edited.",
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  const now = new Date();
  const data = {};

  if (name !== undefined) data.name = String(name).trim();
  if (type !== undefined) data.type = String(type).trim();
  if (maxLoadKg !== undefined) data.maxLoadKg = toFiniteNumber(maxLoadKg, "maxLoadKg", { min: 0 });
  if (region !== undefined) data.region = region || null;
  if (acquisitionCost !== undefined) {
    data.acquisitionCost = toFiniteNumber(acquisitionCost, "acquisitionCost", { min: 0 });
  }
  if (rcNumber !== undefined) data.rcNumber = rcNumber || null;
  if (insuranceNumber !== undefined) data.insuranceNumber = insuranceNumber || null;
  if (pucNumber !== undefined) data.pucNumber = pucNumber || null;

  // The odometer is normally advanced by trip completion. A manual correction is
  // allowed, but it must never move backwards.
  if (odometer !== undefined) {
    const parsed = toFiniteNumber(odometer, "odometer", { min: 0 });
    if (parsed < vehicle.odometer) {
      throw badRequest(
        `Odometer cannot be reduced below its current reading of ${vehicle.odometer.toLocaleString("en-IN")} km.`,
        ERROR_CODES.VALIDATION_FAILED,
        { fields: ["odometer"] }
      );
    }
    data.odometer = parsed;
  }

  if (insuranceExpiry !== undefined) {
    const parsed = insuranceExpiry ? toDate(insuranceExpiry, "insuranceExpiry") : null;
    data.insuranceExpiry = parsed;
    data.insuranceExpired = parsed ? parsed < now : false;
  }

  if (pucExpiry !== undefined) {
    const parsed = pucExpiry ? toDate(pucExpiry, "pucExpiry") : null;
    data.pucExpiry = parsed;
    data.pucExpired = parsed ? parsed < now : false;
  }

  if (Array.isArray(documentUrls)) {
    // Merge rather than replace, so re-scanning does not drop existing documents.
    data.documentUrls = Array.from(new Set([...vehicle.documentUrls, ...documentUrls]));
  }

  if (serviceIntervalKm !== undefined) {
    data.serviceIntervalKm = isMissing(serviceIntervalKm)
      ? null
      : toFiniteNumber(serviceIntervalKm, "serviceIntervalKm", { min: 1 });
  }
  if (lastServiceOdometer !== undefined) {
    data.lastServiceOdometer = toFiniteNumber(lastServiceOdometer, "lastServiceOdometer", { min: 0 });
  }

  if (Object.keys(data).length === 0) {
    throw badRequest("No changes were provided.");
  }

  const updated = await prisma.vehicle.update({ where: { id: req.params.id }, data });

  await writeAudit({
    actor: req.user,
    entity: "Vehicle",
    entityId: updated.id,
    action: AUDIT_ACTIONS.UPDATE,
    summary: `Updated vehicle ${updated.registrationNo}`,
    before: vehicle,
    after: updated,
  });

  return res.status(200).json({
    success: true,
    message: `Vehicle ${updated.registrationNo} updated`,
    data: updated,
  });
});

export const retireVehicle = asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!vehicle) throw notFound("Vehicle");

  if (vehicle.status === "RETIRED") {
    throw badRequest(
      `Vehicle ${vehicle.registrationNo} is already retired.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  if (vehicle.status === "ON_TRIP") {
    throw conflict(
      `Vehicle ${vehicle.registrationNo} is currently on a trip and cannot be retired.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }

  // A retired vehicle must not leave scheduled work stranded.
  const upcoming = await prisma.trip.count({
    where: { vehicleId: vehicle.id, status: { in: ["DRAFT", "DISPATCHED"] } },
  });

  if (upcoming > 0) {
    throw conflict(
      `Vehicle ${vehicle.registrationNo} has ${upcoming} scheduled trip(s). Cancel or reassign them before retiring it.`,
      ERROR_CODES.RESOURCE_BUSY
    );
  }

  const [updated] = await prisma.$transaction([
    prisma.vehicle.update({ where: { id: req.params.id }, data: { status: "RETIRED" } }),
    auditOp({
      actor: req.user,
      entity: "Vehicle",
      entityId: vehicle.id,
      action: AUDIT_ACTIONS.RETIRE,
      summary: `Retired vehicle ${vehicle.registrationNo}`,
      before: { status: vehicle.status },
      after: { status: "RETIRED" },
    }),
  ]);

  return res.status(200).json({
    success: true,
    message: `Vehicle ${updated.registrationNo} retired`,
    data: updated,
  });
});

/** Brings a retired vehicle back into service. */
export const reinstateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!vehicle) throw notFound("Vehicle");

  if (vehicle.status !== "RETIRED") {
    throw badRequest(
      `Vehicle ${vehicle.registrationNo} is not retired.`,
      ERROR_CODES.ILLEGAL_TRANSITION
    );
  }

  const [updated] = await prisma.$transaction([
    prisma.vehicle.update({ where: { id: req.params.id }, data: { status: "AVAILABLE" } }),
    auditOp({
      actor: req.user,
      entity: "Vehicle",
      entityId: vehicle.id,
      action: AUDIT_ACTIONS.REINSTATE,
      summary: `Reinstated vehicle ${vehicle.registrationNo}`,
      before: { status: "RETIRED" },
      after: { status: "AVAILABLE" },
    }),
  ]);

  return res.status(200).json({
    success: true,
    message: `Vehicle ${updated.registrationNo} is back in service`,
    data: updated,
  });
});

export const VEHICLE_STATUS_VALUES = VEHICLE_STATUSES;
