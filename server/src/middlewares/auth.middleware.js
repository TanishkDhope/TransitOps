import jwt from "jsonwebtoken";
import prisma from "../db/prisma.js";
import env from "../config/env.js";
import { rolesFor } from "../config/permissions.js";
import { ERROR_CODES } from "../utils/ApiError.js";

export const verifyJWT = async (req, res, next) => {
  const token =
    req.cookies?.accessToken || req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({
      success: false,
      code: ERROR_CODES.UNAUTHENTICATED,
      message: "You are not signed in. Please log in to continue.",
    });
  }

  let decodedToken;
  try {
    decodedToken = jwt.verify(token, env.accessTokenSecret);
  } catch (error) {
    // ISSUES #15 — distinguish "expired" from "invalid" so the client knows
    // whether to attempt a silent refresh or send the user back to login.
    const expired = error.name === "TokenExpiredError";
    return res.status(401).json({
      success: false,
      code: expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.UNAUTHENTICATED,
      message: expired
        ? "Your session has expired."
        : "Your session is no longer valid. Please log in again.",
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: decodedToken.id },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      driver: { select: { id: true, name: true, status: true } },
    },
  });

  if (!user) {
    return res.status(401).json({
      success: false,
      code: ERROR_CODES.UNAUTHENTICATED,
      message: "Your account no longer exists. Please contact an administrator.",
    });
  }

  req.user = user;
  next();
};

/**
 * ISSUES #2 — role guard. Accepts explicit role names.
 * Prefer `authorize(capability)` below, which reads from the shared permission table.
 */
export const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        code: ERROR_CODES.UNAUTHENTICATED,
        message: "You are not signed in. Please log in to continue.",
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        code: ERROR_CODES.FORBIDDEN,
        message: "You do not have permission to perform this action.",
      });
    }
    next();
  };
};

/**
 * ISSUES #2 — capability guard driven by src/config/permissions.js, so routes
 * declare intent ("vehicle:write") rather than duplicating role lists.
 */
export const authorize = (capability) => {
  const allowed = rolesFor(capability);
  return authorizeRoles(...allowed);
};

export default { verifyJWT, authorizeRoles, authorize };
