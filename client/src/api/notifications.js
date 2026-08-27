import api from "./axios.js";

// ISSUES #4 — this router is now mounted, so these endpoints exist.
export const triggerExpiryCheck = (check) =>
  api.post("/api/v1/notifications/check-expiries", null, { params: check ? { check } : {} });
export const getNotificationLogs = (params) => api.get("/api/v1/notifications/logs", { params });
export const getNotificationStatus = () => api.get("/api/v1/notifications/status");
