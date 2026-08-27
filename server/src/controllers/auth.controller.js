import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import prisma from "../db/prisma.js";
import env from "../config/env.js";
import asyncHandler from "../utils/asyncHandler.js";
import { generateAccessToken, generateRefreshToken } from "../utils/generateTokens.js";
import {
  accessCookieOptions,
  refreshCookieOptions,
  clearCookieOptions,
} from "../utils/cookies.js";
import { badRequest, unauthorized, forbidden, ERROR_CODES } from "../utils/ApiError.js";
import { validateEmail, validatePassword, requireFields } from "../utils/validators.js";
import { writeAudit, AUDIT_ACTIONS } from "../utils/audit.js";

const SAFE_USER_FIELDS = {
  id: true,
  username: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * ISSUES #6 — one shared login throttle. Not a substitute for a real rate
 * limiter behind a proxy, but it stops trivial online password guessing.
 */
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map(); // key -> { count, firstAt }

function throttleKey(req, identifier) {
  return `${req.ip}|${identifier}`;
}

function checkThrottle(key) {
  const entry = attempts.get(key);
  if (!entry) return null;

  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.delete(key);
    return null;
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const minutesLeft = Math.ceil((LOCKOUT_MS - (Date.now() - entry.firstAt)) / 60000);
    return minutesLeft;
  }
  return null;
}

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearFailures(key) {
  attempts.delete(key);
}

/** Issues both tokens, persists the refresh token, and sets both cookies. */
async function issueSession(res, user) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  await prisma.user.update({ where: { id: user.id }, data: { refreshToken } });

  res.cookie("accessToken", accessToken, accessCookieOptions);
  res.cookie("refreshToken", refreshToken, refreshCookieOptions);

  return { accessToken, refreshToken };
}

/**
 * ISSUES #7 — self-registration is disabled by default.
 *
 * TransitOps provisions staff accounts through Admin → User Management. Leaving an
 * open endpoint that mints accounts (previously with the DRIVER role) contradicts
 * that model. Set ALLOW_SELF_REGISTRATION=true to re-enable it for a demo.
 */
export const registerUser = asyncHandler(async (req, res) => {
  if (!env.allowSelfRegistration) {
    // forbidden() — not badRequest(), so the HTTP status matches the FORBIDDEN
    // code the client reads.
    throw forbidden(
      "Self-registration is disabled. Please ask an administrator to create your account."
    );
  }

  requireFields(req.body, ["username", "email", "password"]);

  const username = req.body.username.trim().toLowerCase();
  const email = req.body.email.trim().toLowerCase();
  const password = req.body.password;

  const emailError = validateEmail(email);
  if (emailError) throw badRequest(emailError, ERROR_CODES.VALIDATION_FAILED, { fields: ["email"] });

  // ISSUES #6 — the same policy the admin creation path uses.
  const passwordError = validatePassword(password);
  if (passwordError) {
    throw badRequest(passwordError, ERROR_CODES.VALIDATION_FAILED, { fields: ["password"] });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  // ISSUES #8 — username is now @unique, so the race window in the old
  // read-then-write check is closed by the database. P2002 is mapped to a 409
  // by the global error handler.
  const user = await prisma.user.create({
    data: { username, email, password: hashedPassword },
    select: SAFE_USER_FIELDS,
  });

  await issueSession(res, user);
  await writeAudit({
    actor: user,
    entity: "User",
    entityId: user.id,
    action: AUDIT_ACTIONS.CREATE,
    summary: `Self-registered as ${user.email}`,
    after: user,
  });

  return res.status(201).json({
    success: true,
    message: "Account created successfully",
    user,
  });
});

export const loginUser = asyncHandler(async (req, res) => {
  const email = req.body?.email?.trim().toLowerCase();
  const username = req.body?.username?.trim().toLowerCase();
  const password = req.body?.password;

  if ((!email && !username) || !password) {
    throw badRequest("Email and password are required", ERROR_CODES.VALIDATION_FAILED, {
      fields: [email || username ? "password" : "email"],
    });
  }

  const identifier = email || username;
  const key = throttleKey(req, identifier);

  const lockedMinutes = checkThrottle(key);
  if (lockedMinutes) {
    throw badRequest(
      `Too many failed attempts. Please try again in ${lockedMinutes} minute${lockedMinutes === 1 ? "" : "s"}.`,
      ERROR_CODES.RATE_LIMITED
    );
  }

  // Build the OR branches explicitly: `{ username: undefined }` inside an OR is a
  // Prisma footgun (an empty condition). Only include a branch we actually have.
  const orConditions = [];
  if (email) orConditions.push({ email });
  if (username) orConditions.push({ username });

  const user = await prisma.user.findFirst({ where: { OR: orConditions } });

  // Uniform response for "no such user" and "wrong password" — revealing which
  // one it was lets an attacker enumerate valid accounts.
  const isPasswordValid = user ? await bcrypt.compare(password, user.password) : false;

  if (!user || !isPasswordValid) {
    recordFailure(key);
    throw unauthorized(
      "Incorrect email or password. Please try again.",
      ERROR_CODES.INVALID_CREDENTIALS
    );
  }

  clearFailures(key);
  await issueSession(res, user);

  const loggedInUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { ...SAFE_USER_FIELDS, driver: { select: { id: true, name: true, status: true } } },
  });

  await writeAudit({
    actor: user,
    entity: "User",
    entityId: user.id,
    action: AUDIT_ACTIONS.LOGIN,
    summary: `Signed in from ${req.ip}`,
  });

  return res.status(200).json({
    success: true,
    message: `Welcome back, ${loggedInUser.username}`,
    user: loggedInUser,
  });
});

export const logoutUser = asyncHandler(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { refreshToken: null },
  });

  await writeAudit({
    actor: req.user,
    entity: "User",
    entityId: req.user.id,
    action: AUDIT_ACTIONS.LOGOUT,
    summary: "Signed out",
  });

  return res
    .status(200)
    .clearCookie("accessToken", clearCookieOptions)
    .clearCookie("refreshToken", clearCookieOptions)
    .json({ success: true, message: "You have been signed out" });
});

export const getCurrentUser = asyncHandler(async (req, res) => {
  return res.status(200).json({ success: true, user: req.user });
});

/**
 * ISSUES #15 — now a POST (a GET has no body, so the old `req.body` fallback was
 * dead), and the refresh token is rotated on every use. A replayed old token is
 * rejected because it no longer matches the stored value.
 */
export const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingRefreshToken) {
    throw unauthorized("Your session has expired. Please log in again.", ERROR_CODES.TOKEN_EXPIRED);
  }

  let decodedToken;
  try {
    decodedToken = jwt.verify(incomingRefreshToken, env.refreshTokenSecret);
  } catch {
    throw unauthorized("Your session has expired. Please log in again.", ERROR_CODES.TOKEN_EXPIRED);
  }

  const user = await prisma.user.findUnique({ where: { id: decodedToken.id } });

  if (!user) {
    throw unauthorized("Your account no longer exists.", ERROR_CODES.UNAUTHENTICATED);
  }

  if (user.refreshToken !== incomingRefreshToken) {
    // Either a stale token or a replay. Invalidate the whole session to be safe.
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken: null } });
    throw unauthorized(
      "Your session is no longer valid. Please log in again.",
      ERROR_CODES.TOKEN_EXPIRED
    );
  }

  await issueSession(res, user); // rotates the refresh token

  return res.status(200).json({
    success: true,
    message: "Session refreshed",
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  });
});

/** Lets a signed-in user rotate their own password. */
export const changePassword = asyncHandler(async (req, res) => {
  requireFields(req.body, ["currentPassword", "newPassword"]);

  const { currentPassword, newPassword } = req.body;

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    throw badRequest(passwordError, ERROR_CODES.VALIDATION_FAILED, { fields: ["newPassword"] });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const isValid = await bcrypt.compare(currentPassword, user.password);

  if (!isValid) {
    throw badRequest("Your current password is incorrect.", ERROR_CODES.INVALID_CREDENTIALS, {
      fields: ["currentPassword"],
    });
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  // Rotating the password invalidates existing sessions elsewhere.
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword, refreshToken: null },
  });

  await writeAudit({
    actor: req.user,
    entity: "User",
    entityId: user.id,
    action: AUDIT_ACTIONS.UPDATE,
    summary: "Changed their password",
  });

  return res.status(200).json({ success: true, message: "Password updated successfully" });
});
