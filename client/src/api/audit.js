import api from "./axios.js";

// ISSUES #36 — audit trail.
export const getAuditLogs = (params) => api.get("/api/v1/audit", { params });
export const getEntityHistory = (entity, entityId) =>
  api.get(`/api/v1/audit/${entity}/${entityId}`);
