import bcrypt from "bcrypt";

import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { ASSIGNABLE_ROLES } from "../config/permissions.js";
import { badRequest, notFound, conflict, forbidden, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields, validateEmail, validatePassword, toEnum } from "../utils/validators.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

const SAFE_FIELDS = {
  id: true,
  username: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  driver: { select: { id: true, name: true, status: true } },
};

export const createUser = asyncHandler(async (req, res) => {
  requireFields(req.body, ["username", "email", "password", "role"]);

  const username = req.body.username.trim().toLowerCase();
  const email = req.body.email.trim().toLowerCase();
  const { password, role, driverId } = req.body;

  const emailError = validateEmail(email);
  if (emailError) throw badRequest(emailError, ERROR_CODES.VALIDATION_FAILED, { fields: ["email"] });

  toEnum(role, ASSIGNABLE_ROLES, "role");

  // ISSUES #6 — the same policy the registration path uses.
  const passwordError = validatePassword(password);
  if (passwordError) {
    throw badRequest(passwordError, ERROR_CODES.VALIDATION_FAILED, { fields: ["password"] });
  }

  // ISSUES #37 — a DRIVER login must be linked to a driver record, or the
  // self-service portal has nothing to show them.
  if (role === "DRIVER") {
    if (!driverId) {
      throw badRequest(
        "A driver account must be linked to a driver record.",
        ERROR_CODES.VALIDATION_FAILED,
        { fields: ["driverId"] }
      );
    }
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw notFound("Driver");
    if (driver.userId) {
      throw conflict(`${driver.name} already has a login account.`, ERROR_CODES.DUPLICATE, {
        fields: ["driverId"],
      });
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { username, email, password: hashedPassword, role },
      select: SAFE_FIELDS,
    });

    if (role === "DRIVER" && driverId) {
      await tx.driver.update({ where: { id: driverId }, data: { userId: created.id } });
    }

    return created;
  });

  await writeAudit({
    actor: req.user,
    entity: "User",
    entityId: user.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Created ${role} account for ${email}`,
    after: { username, email, role },
  });

  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: SAFE_FIELDS });

  return res.status(201).json({
    success: true,
    message: `Account created for ${fresh.username}`,
    data: fresh,
  });
});

export const getUsers = asyncHandler(async (req, res) => {
  const { role, search } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(role ? { role } : {}),
    ...(search
      ? {
          OR: [
            { username: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: SAFE_FIELDS,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.user.count({ where }),
  ]);

  return paginated(res, users, total, pagination);
});

export const updateUserRole = asyncHandler(async (req, res) => {
  requireFields(req.body, ["role"]);
  const role = toEnum(req.body.role, ASSIGNABLE_ROLES, "role");

  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { driver: { select: { id: true } } },
  });

  if (!user) throw notFound("User");

  if (user.id === req.user.id) {
    throw forbidden("You cannot change your own role.");
  }

  // Never leave the system without an administrator.
  if (user.role === "ADMIN" && role !== "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      throw badRequest(
        "This is the only administrator account — promote someone else first.",
        ERROR_CODES.ILLEGAL_TRANSITION
      );
    }
  }

  if (role === "DRIVER" && !user.driver) {
    throw badRequest(
      "This account is not linked to a driver record, so it cannot become a driver account.",
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["role"] }
    );
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role, refreshToken: null }, // force re-auth so the new role takes effect everywhere
    select: SAFE_FIELDS,
  });

  await writeAudit({
    actor: req.user,
    entity: "User",
    entityId: user.id,
    action: AUDIT_ACTIONS.UPDATE,
    summary: `Changed ${user.email}'s role: ${user.role} → ${role}`,
    before: { role: user.role },
    after: { role },
  });

  return res.status(200).json({
    success: true,
    message: `${updated.username} is now ${role.replace(/_/g, " ").toLowerCase()}`,
    data: updated,
  });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { driver: { select: { id: true, name: true } } },
  });

  if (!user) throw notFound("User");

  if (user.id === req.user.id) {
    throw forbidden("You cannot delete your own account.");
  }

  if (user.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      throw badRequest(
        "This is the only administrator account and cannot be deleted.",
        ERROR_CODES.ILLEGAL_TRANSITION
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    // Unlink the driver profile first so the driver record itself survives.
    if (user.driver) {
      await tx.driver.update({ where: { id: user.driver.id }, data: { userId: null } });
    }
    await tx.user.delete({ where: { id: user.id } });
  });

  await writeAudit({
    actor: req.user,
    entity: "User",
    entityId: user.id,
    action: AUDIT_ACTIONS.DELETE,
    summary: `Deleted ${user.role} account ${user.email}`,
    before: { username: user.username, email: user.email, role: user.role },
  });

  return res.status(200).json({
    success: true,
    message: `${user.username}'s account has been deleted`,
    data: { id: user.id },
  });
});

/** Driver records without a login, for the "create driver account" picker. */
export const getUnlinkedDrivers = asyncHandler(async (req, res) => {
  const drivers = await prisma.driver.findMany({
    where: { userId: null, status: { not: "ARCHIVED" } },
    select: { id: true, name: true, email: true, licenseNumber: true },
    orderBy: { name: "asc" },
  });

  return res.status(200).json({ success: true, data: drivers });
});
