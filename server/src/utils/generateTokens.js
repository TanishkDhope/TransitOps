import jwt from "jsonwebtoken";
import env from "../config/env.js";

export const generateAccessToken = (user) =>
  jwt.sign({ id: user.id }, env.accessTokenSecret, { expiresIn: env.accessTokenExpiry });

export const generateRefreshToken = (user) =>
  jwt.sign({ id: user.id }, env.refreshTokenSecret, { expiresIn: env.refreshTokenExpiry });

export default { generateAccessToken, generateRefreshToken };
