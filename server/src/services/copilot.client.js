// Outbound client for the private FastAPI copilot service.
//
// The copilot service binds to loopback and is never reachable from the browser;
// Express is its only caller. This module owns the HTTP details and, crucially,
// the error mapping — so the controller stays thin and the client never learns
// that a second service exists (every transport failure becomes a generic
// "integration" error, never a leaked host/port/stacktrace).

import axios from "axios";
import env, { features } from "../config/env.js";
import { ApiError, ERROR_CODES } from "../utils/ApiError.js";

const ASK_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;

export function isCopilotEnabled() {
  return features.copilot;
}

/** Shared guard: refuse before making a call the environment cannot support. */
function assertEnabled() {
  if (!features.copilot) {
    throw new ApiError(400, "Copilot is not configured on this server.", {
      code: ERROR_CODES.INTEGRATION_DISABLED,
    });
  }
}

/**
 * Translate an axios failure into a typed ApiError.
 *   - a 4xx from Python is passed through with its status + message
 *   - connection refused / timeout → INTEGRATION_DISABLED (service unavailable)
 *   - anything else → INTERNAL
 */
function mapAxiosError(error) {
  const response = error?.response;
  if (response) {
    const { status } = response;
    if (status >= 400 && status < 500) {
      const message =
        detailToMessage(response.data) || "The copilot service rejected the request.";
      return new ApiError(status, message, { code: ERROR_CODES.INTEGRATION_FAILED });
    }
    // 5xx or anything unexpected from the service — do not leak it.
    return new ApiError(502, "The copilot service failed to answer.", {
      code: ERROR_CODES.INTEGRATION_FAILED,
    });
  }

  // No response: connection refused, DNS, or timed out.
  if (
    error?.code === "ECONNREFUSED" ||
    error?.code === "ECONNABORTED" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ERR_CANCELED"
  ) {
    return new ApiError(400, "Copilot service is unavailable.", {
      code: ERROR_CODES.INTEGRATION_DISABLED,
    });
  }

  return new ApiError(500, "Something went wrong talking to the copilot service.", {
    code: ERROR_CODES.INTERNAL,
  });
}

/** FastAPI validation errors arrive as { detail: [...] } or { detail: "..." }. */
function detailToMessage(data) {
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  return null;
}

/** POST /ask on the copilot service. Throws a mapped ApiError on any failure. */
export async function askCopilotService({ question, role, capabilities, requestId }) {
  assertEnabled();
  try {
    const { data } = await axios.post(
      `${env.copilotServiceUrl}/ask`,
      { question, role, capabilities, requestId },
      {
        headers: { "x-internal-token": env.internalServiceToken },
        timeout: ASK_TIMEOUT_MS,
      }
    );
    // The copilot answers in its own { success, message, data } envelope.
    // Return the payload alone: the controller puts it inside Express's
    // envelope, and keeping both leaves the client digging through data.data.data
    // for the answer — which is why it rendered nothing at all.
    return data.data;
  } catch (error) {
    throw mapAxiosError(error);
  }
}

/**
 * POST /ask/stream on the copilot service. Returns the raw response whose
 * `.data` is a readable stream of SSE events. The caller (controller) is
 * responsible for piping this stream to the browser response.
 */
export async function streamCopilotService({ question, role, capabilities, requestId }) {
  assertEnabled();
  try {
    const response = await axios.post(
      `${env.copilotServiceUrl}/ask/stream`,
      { question, role, capabilities, requestId },
      {
        headers: { "x-internal-token": env.internalServiceToken },
        timeout: 60_000,
        responseType: "stream",
      }
    );
    return response;
  } catch (error) {
    throw mapAxiosError(error);
  }
}

export async function getCopilotHealth() {
  if (!features.copilot) return false;
  try {
    const { data } = await axios.get(`${env.copilotServiceUrl}/health`, {
      timeout: HEALTH_TIMEOUT_MS,
    });
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

export default { isCopilotEnabled, askCopilotService, streamCopilotService, getCopilotHealth };
