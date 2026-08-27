import env from "../config/env.js";

/**
 * ISSUES #16 — `sameSite: "strict"` only worked because the dev client and API
 * share `localhost` (ports are not part of the same-site computation). In
 * production, `app.example.com` calling `api.example.com` is cross-site, so the
 * browser would silently drop the auth cookies and every request would 401.
 *
 * Production therefore uses `SameSite=None; Secure`, which is the only
 * combination browsers accept for cross-site cookies. Deployments that serve the
 * client and API from one origin can set COOKIE_SAMESITE=lax to keep CSRF
 * protection from the cookie layer itself.
 */
const sameSite =
  process.env.COOKIE_SAMESITE || (env.isProduction ? "none" : "lax");

const secure =
  process.env.COOKIE_SECURE != null
    ? process.env.COOKIE_SECURE === "true"
    : env.isProduction || sameSite === "none";

const baseOptions = {
  httpOnly: true,
  secure,
  sameSite,
  path: "/",
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
};

/** Parses "15m" / "1d" / "7d" / raw seconds into milliseconds. */
function expiryToMs(expiry, fallbackMs) {
  if (!expiry) return fallbackMs;
  const match = String(expiry).trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!match) return fallbackMs;

  const value = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * (multipliers[unit] ?? 1000);
}

export const accessCookieOptions = {
  ...baseOptions,
  maxAge: expiryToMs(env.accessTokenExpiry, 24 * 60 * 60 * 1000),
};

export const refreshCookieOptions = {
  ...baseOptions,
  maxAge: expiryToMs(env.refreshTokenExpiry, 7 * 24 * 60 * 60 * 1000),
};

/** clearCookie must receive the same flags the cookie was set with. */
export const clearCookieOptions = baseOptions;

export default { accessCookieOptions, refreshCookieOptions, clearCookieOptions };
