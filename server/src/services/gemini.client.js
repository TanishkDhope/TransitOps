import { GoogleGenAI } from "@google/genai";
import env, { features } from "../config/env.js";
import { ApiError, ERROR_CODES } from "../utils/ApiError.js";

// ISSUES #1 — the client is created on first use, not at module load, so it can
// never be constructed with an undefined API key because of import ordering.
let client = null;

export const GEMINI_MODEL = "gemini-3.1-flash-lite";

export function isGeminiEnabled() {
  return features.gemini;
}

export function getGeminiClient() {
  if (!features.gemini) {
    throw new ApiError(503, "Automatic document scanning is not configured on this server.", {
      code: ERROR_CODES.INTEGRATION_DISABLED,
    });
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }
  return client;
}

/**
 * Strips markdown fences and parses the model's response.
 * Falls back to the first balanced `{...}` block, because a model occasionally
 * prefixes prose despite being told not to.
 */
export function parseJsonResponse(text, context = "document") {
  if (!text || typeof text !== "string") {
    throw new ApiError(502, `The scanner returned an empty response for the ${context}.`, {
      code: ERROR_CODES.INTEGRATION_FAILED,
    });
  }

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through to the error below */
      }
    }
    throw new ApiError(
      502,
      `Could not read the ${context}. Please retake the photo or enter the details manually.`,
      { code: ERROR_CODES.INTEGRATION_FAILED }
    );
  }
}

/** Normalises a model-supplied date to YYYY-MM-DD, or "" when unusable. */
export function normaliseDate(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return Number.isNaN(new Date(trimmed).getTime()) ? "" : trimmed;
  }
  // Accept DD-MM-YYYY and DD/MM/YYYY, the formats on Indian documents.
  const match = trimmed.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const iso = `${year}-${month}-${day}`;
    return Number.isNaN(new Date(iso).getTime()) ? "" : iso;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

export default { getGeminiClient, parseJsonResponse, normaliseDate, isGeminiEnabled, GEMINI_MODEL };
