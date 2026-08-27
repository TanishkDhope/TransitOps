/**
 * Structured API error.
 *
 * `code` is a stable machine-readable identifier the frontend maps to a specific
 * toast, so the UI never has to string-match on human-readable messages.
 */
export class ApiError extends Error {
  constructor(status, message, { code = null, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ERROR_CODES = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  DUPLICATE: "DUPLICATE",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  RESOURCE_BUSY: "RESOURCE_BUSY",
  SCHEDULE_CONFLICT: "SCHEDULE_CONFLICT",
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",
  INTEGRATION_DISABLED: "INTEGRATION_DISABLED",
  INTEGRATION_FAILED: "INTEGRATION_FAILED",
  IN_USE: "IN_USE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
};

export const badRequest = (message, code = ERROR_CODES.VALIDATION_FAILED, details) =>
  new ApiError(400, message, { code, details });

export const unauthorized = (message = "Unauthorized request", code = ERROR_CODES.UNAUTHENTICATED) =>
  new ApiError(401, message, { code });

export const forbidden = (message = "You do not have permission to perform this action") =>
  new ApiError(403, message, { code: ERROR_CODES.FORBIDDEN });

export const notFound = (what = "Resource") =>
  new ApiError(404, `${what} not found`, { code: ERROR_CODES.NOT_FOUND });

export const conflict = (message, code = ERROR_CODES.DUPLICATE, details) =>
  new ApiError(409, message, { code, details });

export default ApiError;
