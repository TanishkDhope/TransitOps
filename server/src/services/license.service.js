import {
  getGeminiClient,
  parseJsonResponse,
  normaliseDate,
  GEMINI_MODEL,
} from "./gemini.client.js";

const EXTRACTION_PROMPT = `
These are the front and back of the SAME driver's license.

Combine information from both images.

Return ONLY valid JSON, no markdown fences, matching exactly this shape:

{
  "name": "",
  "licenseNumber": "",
  "licenseCategory": [],
  "dateOfBirth": "",
  "issueDate": "",
  "licenseExpiry": "",
  "address": "",
  "issuingAuthority": "",
  "bloodGroup": ""
}

Dates must be in YYYY-MM-DD format. If a field cannot be read, leave it as an empty string (or empty array for licenseCategory).
`;

/**
 * Extracts structured details from the two sides of a driving licence.
 * Throws an ApiError (503 when Gemini is unconfigured, 502 when the model output
 * is unusable) so the caller can decide whether to degrade or fail.
 */
export async function extractLicenseDetails(
  frontBuffer,
  backBuffer,
  { frontMimeType = "image/jpeg", backMimeType = "image/jpeg" } = {}
) {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { inlineData: { mimeType: frontMimeType, data: frontBuffer.toString("base64") } },
      { inlineData: { mimeType: backMimeType, data: backBuffer.toString("base64") } },
      { text: EXTRACTION_PROMPT },
    ],
  });

  const parsed = parseJsonResponse(response.text, "driving licence");

  // Normalise so the caller always receives the same shape, whatever the model returned.
  return {
    name: parsed.name?.trim() || "",
    licenseNumber: parsed.licenseNumber?.trim() || "",
    licenseCategory: Array.isArray(parsed.licenseCategory)
      ? parsed.licenseCategory
      : parsed.licenseCategory
        ? [parsed.licenseCategory]
        : [],
    dateOfBirth: normaliseDate(parsed.dateOfBirth),
    issueDate: normaliseDate(parsed.issueDate),
    licenseExpiry: normaliseDate(parsed.licenseExpiry),
    address: parsed.address?.trim() || "",
    issuingAuthority: parsed.issuingAuthority?.trim() || "",
    bloodGroup: parsed.bloodGroup?.trim() || "",
  };
}

export default extractLicenseDetails;
