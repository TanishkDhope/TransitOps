// Shared validation. ISSUES #6 (one password policy) and #20 (`== null`, not falsy).

import { badRequest, ERROR_CODES } from "./ApiError.js";

export const PASSWORD_MIN_LENGTH = 8;

/**
 * ISSUES #6 — one password policy, used by both registration paths and mirrored
 * by the client so the rules can never drift.
 */
export function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return "Password is required";
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  }
  if (!/[A-Za-z]/.test(password)) {
    return "Password must contain at least one letter";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number";
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email) {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return "Please provide a valid email address";
  }
  return null;
}

/**
 * ISSUES #20 — `!value` rejects legitimate 0 and "".
 * Presence means "not null and not undefined", plus "not an empty/blank string".
 */
export function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

/**
 * Throws a single 400 naming every missing field, so the client can show one
 * actionable toast instead of making the user resubmit field by field.
 */
export function requireFields(body, fields) {
  const missing = fields.filter((field) => isMissing(body?.[field]));
  if (missing.length > 0) {
    throw badRequest(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`,
      ERROR_CODES.VALIDATION_FAILED,
      { fields: missing }
    );
  }
}

/** Coerces to a finite number, throwing a clear 400 when the input is not numeric. */
export function toFiniteNumber(value, fieldName, { min = null, max = null } = {}) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw badRequest(`${fieldName} must be a number`, ERROR_CODES.VALIDATION_FAILED, {
      fields: [fieldName],
    });
  }
  if (min !== null && num < min) {
    throw badRequest(`${fieldName} must be at least ${min}`, ERROR_CODES.VALIDATION_FAILED, {
      fields: [fieldName],
    });
  }
  if (max !== null && num > max) {
    throw badRequest(`${fieldName} must be at most ${max}`, ERROR_CODES.VALIDATION_FAILED, {
      fields: [fieldName],
    });
  }
  return num;
}

/** Parses a date, throwing a clear 400 rather than silently producing `Invalid Date`. */
export function toDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`${fieldName} must be a valid date`, ERROR_CODES.VALIDATION_FAILED, {
      fields: [fieldName],
    });
  }
  return date;
}

/** Validates a value against an enum, listing the valid options on failure. */
export function toEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw badRequest(
      `${fieldName} must be one of: ${allowed.join(", ")}`,
      ERROR_CODES.VALIDATION_FAILED,
      { fields: [fieldName] }
    );
  }
  return value;
}

export default {
  validatePassword,
  validateEmail,
  isMissing,
  requireFields,
  toFiniteNumber,
  toDate,
  toEnum,
  PASSWORD_MIN_LENGTH,
};
