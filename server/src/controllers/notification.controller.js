import prisma from "../db/prisma.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  runAllChecks,
  checkExpiringLicenses,
  checkVehicleInsurance,
  checkVehiclePuc,
  checkServiceDue,
} from "../services/notification.service.js";
import { isEmailEnabled } from "../services/email.service.js";
import { badRequest, ERROR_CODES } from "../utils/ApiError.js";
import { getPagination, paginated } from "../utils/pagination.js";
import { toEnum } from "../utils/validators.js";

const CHECKS = {
  licenses: checkExpiringLicenses,
  insurance: checkVehicleInsurance,
  puc: checkVehiclePuc,
  service: checkServiceDue,
};

/**
 * ISSUES #4 — this endpoint existed but its router was never mounted, so there
 * was no way to run a sweep on demand: a demo had to wait for the cron.
 */
export const triggerExpiryCheck = asyncHandler(async (req, res) => {
  if (!isEmailEnabled()) {
    throw badRequest(
      "Email is not configured on this server, so notifications cannot be sent.",
      ERROR_CODES.INTEGRATION_DISABLED
    );
  }

  const { check } = req.query;

  if (check) {
    const key = toEnum(check, Object.keys(CHECKS), "check");
    const result = await CHECKS[key]();
    return res.status(200).json({
      success: true,
      message: `${key} check completed`,
      data: { [key]: result },
    });
  }

  const result = await runAllChecks();

  const totalSent =
    (result.licenses.sent ?? 0) +
    (result.insurance.sent ?? 0) +
    (result.puc.sent ?? 0) +
    (result.service.sent ?? 0);

  return res.status(200).json({
    success: true,
    message:
      totalSent > 0
        ? `Expiry check complete — ${totalSent} notification(s) sent`
        : "Expiry check complete — nothing new to report",
    data: result,
  });
});

/** ISSUES #38 — the delivery record, so nobody has to guess whether a notice went out. */
export const getNotificationLogs = asyncHandler(async (req, res) => {
  const { type, subjectId, recipient, success } = req.query;
  const pagination = getPagination(req.query);

  const where = {
    ...(type ? { type } : {}),
    ...(subjectId ? { subjectId } : {}),
    ...(recipient ? { recipient: { contains: recipient, mode: "insensitive" } } : {}),
    ...(success !== undefined ? { success: success === "true" } : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.notificationLog.findMany({
      where,
      orderBy: { sentAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.notificationLog.count({ where }),
  ]);

  return paginated(res, logs, total, pagination);
});

/** Whether the optional integrations are actually available, for the Settings page. */
export const getNotificationStatus = asyncHandler(async (req, res) => {
  const [lastSent, failedCount] = await Promise.all([
    prisma.notificationLog.findFirst({ orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
    prisma.notificationLog.count({
      where: { success: false, sentAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      emailEnabled: isEmailEnabled(),
      lastSentAt: lastSent?.sentAt ?? null,
      failuresLast24h: failedCount,
    },
  });
});
