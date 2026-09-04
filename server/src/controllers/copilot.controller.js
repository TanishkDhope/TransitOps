import crypto from "node:crypto";

import asyncHandler from "../utils/asyncHandler.js";
import { badRequest, ApiError, ERROR_CODES } from "../utils/ApiError.js";
import { requireFields } from "../utils/validators.js";
import { writeAudit } from "../utils/audit.js";
import { capabilitiesFor } from "../config/permissions.js";
import { features } from "../config/env.js";
import { askCopilotService, streamCopilotService, getCopilotHealth } from "../services/copilot.client.js";

const QUESTION_MAX_LENGTH = 500;

/**
 * POST /api/v1/copilot/ask
 * Proxies a question to the private copilot service. Auth + RBAC are already
 * enforced by the router (verifyJWT + authorize("copilot:query")).
 */
export const askCopilot = asyncHandler(async (req, res) => {
  if (!features.copilot) {
    throw new ApiError(400, "Copilot is not configured on this server.", {
      code: ERROR_CODES.INTEGRATION_DISABLED,
    });
  }

  requireFields(req.body, ["question"]);
  const question = String(req.body.question).trim();
  if (question.length > QUESTION_MAX_LENGTH) {
    throw badRequest(
      `question must be at most ${QUESTION_MAX_LENGTH} characters`,
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["question"] }
    );
  }

  const requestId = crypto.randomUUID();
  // TODO: gates view access in the SQL slice — the copilot service does not
  // consume this yet, but pinning it now means retrieval/scoping needs no
  // signature change later.
  const capabilities = capabilitiesFor(req.user.role);

  const answer = await askCopilotService({
    question,
    role: req.user.role,
    capabilities,
    requestId,
  });

  await writeAudit({
    actor: req.user,
    entity: "Copilot",
    entityId: requestId,
    action: "QUERY",
    summary: question.slice(0, 200),
  });

  return res.json({
    success: true,
    message: "Copilot responded.",
    data: answer,
  });
});

/**
 * POST /api/v1/copilot/ask/stream
 * SSE streaming variant of askCopilot. Pipes progress events from the copilot
 * service to the browser in real time.
 */
export const askCopilotStream = asyncHandler(async (req, res) => {
  if (!features.copilot) {
    throw new ApiError(400, "Copilot is not configured on this server.", {
      code: ERROR_CODES.INTEGRATION_DISABLED,
    });
  }

  requireFields(req.body, ["question"]);
  const question = String(req.body.question).trim();
  if (question.length > QUESTION_MAX_LENGTH) {
    throw badRequest(
      `question must be at most ${QUESTION_MAX_LENGTH} characters`,
      ERROR_CODES.VALIDATION_FAILED,
      { fields: ["question"] }
    );
  }

  const requestId = crypto.randomUUID();
  const capabilities = capabilitiesFor(req.user.role);

  const upstream = await streamCopilotService({
    question,
    role: req.user.role,
    capabilities,
    requestId,
  });

  // SSE headers — must be set before the first write.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Pipe the upstream SSE stream directly to the client.
  upstream.data.pipe(res);

  // Audit once the stream closes.
  upstream.data.on("end", () => {
    writeAudit({
      actor: req.user,
      entity: "Copilot",
      entityId: requestId,
      action: "QUERY",
      summary: question.slice(0, 200),
    }).catch(() => {});
  });
});

/**
 * GET /api/v1/copilot/status
 * Lets the client show a disabled state when copilot is off or unreachable,
 * without ever revealing that a second service is involved.
 */
export const getCopilotStatus = asyncHandler(async (req, res) => {
  const available = features.copilot ? await getCopilotHealth() : false;
  return res.json({
    success: true,
    message: "Copilot status.",
    data: { available },
  });
});

export default { askCopilot, askCopilotStream, getCopilotStatus };
