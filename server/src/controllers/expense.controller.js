import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { refreshSafetyScore } from "../services/safety.service.js";
import { badRequest, notFound, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, toDate, toEnum, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

const EXPENSE_TYPES = ["TOLL", "PARKING", "FINE", "MAINTENANCE", "OTHER"];

export const createExpense = asyncHandler(async (req, res) => {
  requireFields(req.body, ["vehicleId", "type"]);

  const { vehicleId, tripId, type, amount, note, incurredAt } = req.body;

  if (isMissing(amount)) {
    throw badRequest("amount is required", ERROR_CODES.VALIDATION_FAILED, { fields: ["amount"] });
  }

  toEnum(type, EXPENSE_TYPES, "type");
  const parsedAmount = toFiniteNumber(amount, "amount", { min: 0 });

  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) throw notFound("Vehicle");

  let trip = null;
  if (tripId) {
    trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, vehicleId: true, driverId: true, source: true, destination: true },
    });
    if (!trip) throw notFound("Trip");
    if (trip.vehicleId !== vehicleId) {
      throw badRequest(
        `That trip (${trip.source} → ${trip.destination}) was run by a different vehicle.`,
        ERROR_CODES.VALIDATION_FAILED,
        { fields: ["tripId"] }
      );
    }
  }

  // MAINTENANCE-type expenses would be double-counted against maintenance logs
  // in every cost report, so the type is rejected here and users are pointed at
  // the maintenance module instead (ISSUES #12).
  if (type === "MAINTENANCE") {
    throw badRequest(
      "Record repairs as a maintenance job instead — that keeps them out of the cost reports twice.",
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["type"] }
    );
  }

  const expense = await prisma.expense.create({
    data: {
      vehicleId,
      ...(tripId ? { tripId } : {}),
      type,
      amount: parsedAmount,
      ...(isMissing(note) ? {} : { note: String(note).trim() }),
      ...(isMissing(incurredAt) ? {} : { incurredAt: toDate(incurredAt, "incurredAt") }),
    },
    include: { vehicle: { select: { id: true, registrationNo: true, name: true } } },
  });

  // ISSUES #32 — a fine on a trip costs that driver safety points.
  if (type === "FINE" && trip?.driverId) {
    await refreshSafetyScore(trip.driverId);
  }

  await writeAudit({
    actor: req.user,
    entity: "Expense",
    entityId: expense.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Logged ${type} of ₹${parsedAmount} for ${vehicle.registrationNo}`,
    after: { vehicleId, tripId, type, amount: parsedAmount },
  });

  return res.status(201).json({
    success: true,
    message:
      type === "FINE"
        ? `Fine recorded — the driver's safety score has been updated`
        : `${type.charAt(0)}${type.slice(1).toLowerCase()} expense recorded`,
    data: expense,
  });
});

export const getExpenses = asyncHandler(async (req, res) => {
  const { vehicleId, tripId, type, from, to } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(vehicleId ? { vehicleId } : {}),
    ...(tripId ? { tripId } : {}),
    ...(type ? { type } : {}),
    ...(from || to
      ? {
          incurredAt: {
            ...(from ? { gte: toDate(from, "from") } : {}),
            ...(to ? { lte: toDate(to, "to") } : {}),
          },
        }
      : {}),
  };

  const [expenses, total, aggregate] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { incurredAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        vehicle: { select: { id: true, registrationNo: true, name: true } },
        trip: { select: { id: true, source: true, destination: true } },
      },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);

  return paginated(res, expenses, total, pagination, {
    totals: { amount: Number(aggregate._sum.amount ?? 0) },
  });
});

export const deleteExpense = asyncHandler(async (req, res) => {
  const expense = await prisma.expense.findUnique({
    where: { id: req.params.id },
    include: { trip: { select: { driverId: true } } },
  });

  if (!expense) throw notFound("Expense");

  await prisma.expense.delete({ where: { id: expense.id } });

  if (expense.type === "FINE" && expense.trip?.driverId) {
    await refreshSafetyScore(expense.trip.driverId);
  }

  await writeAudit({
    actor: req.user,
    entity: "Expense",
    entityId: expense.id,
    action: AUDIT_ACTIONS.DELETE,
    summary: `Deleted ${expense.type} expense of ₹${expense.amount}`,
    before: expense,
  });

  return res.status(200).json({ success: true, message: "Expense deleted", data: { id: expense.id } });
});

export const EXPENSE_TYPE_VALUES = EXPENSE_TYPES;
