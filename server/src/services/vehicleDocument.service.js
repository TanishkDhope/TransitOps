import {
  getGeminiClient,
  parseJsonResponse,
  normaliseDate,
  GEMINI_MODEL,
} from "./gemini.client.js";

const EXTRACTION_PROMPT = `
These images are documents for the SAME vehicle — any mix of Registration Certificate (RC),
Insurance policy, and PUC (Pollution Under Control) certificate. There may be 1 to several images.

Combine information across all images.

Return ONLY valid JSON, no markdown fences, matching exactly this shape:

{
  "rcNumber": "",
  "insuranceNumber": "",
  "insuranceExpiry": "",
  "pucNumber": "",
  "pucExpiry": ""
}

Dates must be in YYYY-MM-DD format. If a field cannot be read or the relevant document wasn't provided, leave it as an empty string.
`;

export const EMPTY_VEHICLE_EXTRACTION = {
  rcNumber: "",
  insuranceNumber: "",
  insuranceExpiry: "",
  pucNumber: "",
  pucExpiry: "",
};

/** Extracts RC / insurance / PUC details from one or more document photos. */
export async function extractVehicleDocumentDetails(files) {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      ...files.map((file) => ({
        inlineData: {
          mimeType: file.mimetype || "image/jpeg",
          data: file.buffer.toString("base64"),
        },
      })),
      { text: EXTRACTION_PROMPT },
    ],
  });

  const parsed = parseJsonResponse(response.text, "vehicle documents");

  return {
    rcNumber: parsed.rcNumber?.trim() || "",
    insuranceNumber: parsed.insuranceNumber?.trim() || "",
    insuranceExpiry: normaliseDate(parsed.insuranceExpiry),
    pucNumber: parsed.pucNumber?.trim() || "",
    pucExpiry: normaliseDate(parsed.pucExpiry),
  };
}

export default extractVehicleDocumentDetails;
