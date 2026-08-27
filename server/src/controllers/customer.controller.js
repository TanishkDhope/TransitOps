// ISSUES #33 — Customers and rate cards.
// Trip revenue used to be a free-text number typed at completion, so every ROI
// figure rested on whatever someone happened to enter, and the system had no
// notion of who a load was actually for.

import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { computeRevenue, explainRevenue } from "../services/pricing.service.js";
import { badRequest, notFound, conflict, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, toFiniteNumber, validateEmail, isMissing } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

function parseRateCard(body) {
  const data = {};

  for (const field of ["ratePerKm", "ratePerTonneKm", "flatRate"]) {
    if (body[field] !== undefined) {
      data[field] = isMissing(body[field]) ? null : toFiniteNumber(body[field], field, { min: 0 });
    }
  }

  return data;
}

export const createCustomer = asyncHandler(async (req, res) => {
  requireFields(req.body, ["name"]);

  const { name, email, phone } = req.body;

  if (!isMissing(email)) {
    const emailError = validateEmail(email);
    if (emailError) {
      throw badRequest(emailError, ERROR_CODES.VALIDATION_FAILED, { fields: ["email"] });
    }
  }

  const rateCard = parseRateCard(req.body);

  const hasRate =
    (rateCard.ratePerKm ?? 0) > 0 ||
    (rateCard.ratePerTonneKm ?? 0) > 0 ||
    (rateCard.flatRate ?? 0) > 0;

  const customer = await prisma.customer.create({
    data: {
      name: String(name).trim(),
      ...(isMissing(email) ? {} : { email: String(email).trim().toLowerCase() }),
      ...(isMissing(phone) ? {} : { phone: String(phone).trim() }),
      ...rateCard,
    },
  });

  await writeAudit({
    actor: req.user,
    entity: "Customer",
    entityId: customer.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Added customer ${customer.name}`,
    after: customer,
  });

  return res.status(201).json({
    success: true,
    message: hasRate
      ? `Customer ${customer.name} added with a rate card`
      : `Customer ${customer.name} added — add a rate card to compute trip revenue automatically`,
    data: customer,
  });
});

export const getCustomers = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const pagination = getPagination(req.query);

  const where = search ? { name: { contains: search, mode: "insensitive" } } : {};

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: "asc" },
      skip: pagination.skip,
      take: pagination.take,
      include: { _count: { select: { trips: true } } },
    }),
    prisma.customer.count({ where }),
  ]);

  return paginated(res, customers, total, pagination);
});

export const getCustomerById = asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { trips: true } },
      trips: {
        orderBy: { plannedStart: "desc" },
        take: 10,
        select: {
          id: true,
          source: true,
          destination: true,
          status: true,
          revenue: true,
          plannedStart: true,
        },
      },
    },
  });

  if (!customer) throw notFound("Customer");

  return res.status(200).json({ success: true, data: customer });
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;

  const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!customer) throw notFound("Customer");

  const data = { ...parseRateCard(req.body) };

  if (name !== undefined) data.name = String(name).trim();
  if (email !== undefined) {
    if (isMissing(email)) {
      data.email = null;
    } else {
      const emailError = validateEmail(email);
      if (emailError) {
        throw badRequest(emailError, ERROR_CODES.VALIDATION_FAILED, { fields: ["email"] });
      }
      data.email = String(email).trim().toLowerCase();
    }
  }
  if (phone !== undefined) data.phone = isMissing(phone) ? null : String(phone).trim();

  if (Object.keys(data).length === 0) throw badRequest("No changes were provided.");

  const updated = await prisma.customer.update({ where: { id: customer.id }, data });

  await writeAudit({
    actor: req.user,
    entity: "Customer",
    entityId: customer.id,
    action: AUDIT_ACTIONS.UPDATE,
    summary: `Updated customer ${updated.name}`,
    before: customer,
    after: updated,
  });

  return res.status(200).json({
    success: true,
    message: `Customer ${updated.name} updated`,
    data: updated,
  });
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { trips: true } } },
  });

  if (!customer) throw notFound("Customer");

  if (customer._count.trips > 0) {
    throw conflict(
      `${customer.name} has ${customer._count.trips} trip(s) on record and cannot be deleted.`,
      ERROR_CODES.IN_USE
    );
  }

  await prisma.customer.delete({ where: { id: customer.id } });

  await writeAudit({
    actor: req.user,
    entity: "Customer",
    entityId: customer.id,
    action: AUDIT_ACTIONS.DELETE,
    summary: `Deleted customer ${customer.name}`,
    before: customer,
  });

  return res.status(200).json({
    success: true,
    message: `Customer ${customer.name} deleted`,
    data: { id: customer.id },
  });
});

/** Previews what a rate card would charge, so a dispatcher sees the figure before saving. */
export const quoteTrip = asyncHandler(async (req, res) => {
  const { customerId, plannedDistance, cargoWeightKg } = req.query;

  if (!customerId) throw badRequest("customerId is required");

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw notFound("Customer");

  const distanceKm = Number(plannedDistance) || 0;
  const cargo = Number(cargoWeightKg) || 0;

  const revenue = computeRevenue({ customer, distanceKm, cargoWeightKg: cargo });

  return res.status(200).json({
    success: true,
    data: {
      revenue,
      basis: explainRevenue({ customer, distanceKm, cargoWeightKg: cargo }),
      hasRateCard: revenue != null,
    },
  });
});
