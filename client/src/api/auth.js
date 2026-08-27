import api from "./axios.js";

export const loginUser = (credentials) => api.post("/api/v1/auth/login", credentials);
export const logoutUser = () => api.post("/api/v1/auth/logout");
export const getCurrentUser = () => api.get("/api/v1/auth/current-user");
// ISSUES #15 — POST, and actually driven by the axios interceptor rather than never called.
export const refreshAccessToken = () => api.post("/api/v1/auth/refresh-token");
export const changePassword = (payload) => api.post("/api/v1/auth/change-password", payload);
