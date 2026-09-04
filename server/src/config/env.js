// ISSUES #1 — Environment must be loaded BEFORE any module reads process.env.
//
// ES module imports are hoisted and fully evaluated before the importing module's
// body runs. The previous `import dotenv` + `dotenv.config()` in index.js therefore
// executed *after* app.js and every service had already been evaluated, so Cloudinary,
// Gemini and Nodemailer were all constructed with `undefined` credentials.
//
// This module performs the load as an import side effect and is imported first
// everywhere it matters, so `process.env` is populated by the time any consumer reads it.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve .env relative to this file rather than process.cwd(), so the server
// starts correctly no matter which directory it is launched from.
// fileURLToPath (not URL.pathname) — the repo path contains a space.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(serverRoot, ".env") });

/** Variables the server cannot start without. */
const REQUIRED = [
  "DATABASE_URL",
  "ACCESS_TOKEN_SECRET",
  "REFRESH_TOKEN_SECRET",
  "ACCESS_TOKEN_EXPIRY",
  "REFRESH_TOKEN_EXPIRY",
];

/**
 * Variables that only gate an optional integration. A missing one disables that
 * feature with a clear warning instead of failing silently at the first request.
 */
const OPTIONAL_FEATURES = {
  gemini: ["GEMINI_API_KEY"],
  cloudinary: ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
  email: ["GMAIL_USER", "GMAIL_APP_PASSWORD"],
  // Copilot is available only when both the service URL and the shared internal
  // token are configured; either one missing disables the integration cleanly.
  copilot: ["COPILOT_SERVICE_URL", "INTERNAL_SERVICE_TOKEN"],
};

const missingRequired = REQUIRED.filter((key) => !process.env[key]);

if (missingRequired.length > 0) {
  console.error(
    `\n❌ Missing required environment variable(s): ${missingRequired.join(", ")}\n` +
      `   Add them to server/.env and restart.\n`
  );
  process.exit(1);
}

/** Which optional integrations actually have credentials. */
export const features = Object.fromEntries(
  Object.entries(OPTIONAL_FEATURES).map(([name, keys]) => [
    name,
    keys.every((key) => Boolean(process.env[key])),
  ])
);

for (const [name, enabled] of Object.entries(features)) {
  if (!enabled) {
    console.warn(
      `⚠  ${name} integration disabled — missing ${OPTIONAL_FEATURES[name]
        .filter((k) => !process.env[k])
        .join(", ")}`
    );
  }
}

export const env = {
  port: Number(process.env.PORT) || 8000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  corsOrigins: (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET,
  accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY,
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET,
  refreshTokenExpiry: process.env.REFRESH_TOKEN_EXPIRY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  copilotServiceUrl: process.env.COPILOT_SERVICE_URL,
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,
  gmailUser: process.env.GMAIL_USER,
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  // ISSUES #7 — public self-registration is off unless explicitly re-enabled.
  allowSelfRegistration: process.env.ALLOW_SELF_REGISTRATION === "true",
};

export default env;
