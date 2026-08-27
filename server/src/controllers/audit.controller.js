// ISSUES #36 — Read access to the audit trail.

import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { toDate } from "../utils/validators.js";

export const getAuditLogs = asyncHandler(async (req, res) => {
  const { entity, entityId, actorId, action, from, to } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(entity ? { entity } : {}),
    ...(entityId ? { entityId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(action ? { action } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: toDate(from, "from") } : {}),
            ...(to ? { lte: toDate(to, "to") } : {}),
          },
        }
      : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
      include: { actor: { select: { id: true, username: true, email: true, role: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return paginated(res, logs, total, pagination);
});

/** Full history for one record, for the "activity" panel on a detail page. */
export const getEntityHistory = asyncHandler(async (req, res) => {
  const { entity, entityId } = req.params;

  const logs = await prisma.auditLog.findMany({
    where: { entity, entityId },
    orderBy: { createdAt: "desc" },
    include: { actor: { select: { id: true, username: true, email: true, role: true } } },
    take: 100,
  });

  return res.status(200).json({ success: true, data: logs });
});
