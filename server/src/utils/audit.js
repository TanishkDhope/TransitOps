// ISSUES #36 — Audit trail.
//
// Two entry points:
//   auditOp(...)   → a Prisma operation you splice into an existing $transaction,
//                    so the audit row commits atomically with the mutation it describes.
//   writeAudit(...)→ fire-and-forget for single-statement mutations; never throws,
//                    because losing an audit row must not fail the user's request.

import prisma from "../db/prisma.js";

/** Fields that must never be persisted into the audit trail. */
const REDACTED_KEYS = new Set(["password", "refreshToken", "accessToken", "token"]);

/** Prisma Decimal / Date values are not JSON-serialisable as-is. */
function serialise(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialise);
  if (typeof value === "object") {
    // Prisma Decimal exposes toFixed; convert to a plain number-like string.
    if (typeof value.toFixed === "function" && typeof value.toNumber === "function") {
      return value.toString();
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (REDACTED_KEYS.has(key)) continue;
      out[key] = serialise(val);
    }
    return out;
  }
  return value;
}

/** Only keep fields that actually changed, so the trail stays readable. */
function diff(before, after) {
  if (!before || !after) return { before: serialise(before), after: serialise(after) };
  const changedBefore = {};
  const changedAfter = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (REDACTED_KEYS.has(key)) continue;
    const b = serialise(before[key]);
    const a = serialise(after[key]);
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changedBefore[key] = b;
      changedAfter[key] = a;
    }
  }
  return { before: changedBefore, after: changedAfter };
}

function buildData({ actor, entity, entityId, action, summary, before, after }) {
  const payload =
    before && after ? diff(before, after) : { before: serialise(before), after: serialise(after) };

  return {
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    entity,
    entityId,
    action,
    summary: summary ?? null,
    before: payload.before ?? undefined,
    after: payload.after ?? undefined,
  };
}

/**
 * Returns an un-awaited Prisma create you can include in a `$transaction([...])`
 * array so the audit row is committed with the mutation.
 */
export function auditOp(options) {
  return prisma.auditLog.create({ data: buildData(options) });
}

/** Best-effort audit write for mutations that are not already in a transaction. */
export async function writeAudit(options) {
  try {
    await prisma.auditLog.create({ data: buildData(options) });
  } catch (error) {
    console.error("[audit] failed to record entry:", error.message);
  }
}

export const AUDIT_ACTIONS = {
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  ARCHIVE: "ARCHIVE",
  RETIRE: "RETIRE",
  SUSPEND: "SUSPEND",
  REINSTATE: "REINSTATE",
  STATUS_CHANGE: "STATUS_CHANGE",
  DISPATCH: "DISPATCH",
  COMPLETE: "COMPLETE",
  CANCEL: "CANCEL",
  OPEN: "OPEN",
  CLOSE: "CLOSE",
  LOGIN: "LOGIN",
  LOGOUT: "LOGOUT",
};

export default { auditOp, writeAudit, AUDIT_ACTIONS };
