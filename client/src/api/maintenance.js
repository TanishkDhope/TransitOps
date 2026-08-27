import api from "./axios.js";

export const getMaintenanceLogs = (params) => api.get("/api/v1/maintenance", { params });
export const getMaintenanceLog = (id) => api.get(`/api/v1/maintenance/${id}`);
export const createMaintenanceLog = (data) => api.post("/api/v1/maintenance", data);
export const updateMaintenanceLog = (id, data) => api.patch(`/api/v1/maintenance/${id}`, data);
export const closeMaintenanceLog = (id, data) => api.patch(`/api/v1/maintenance/${id}/close`, data);
// ISSUES #34 — preventive service schedule.
export const getServiceDueVehicles = (params) =>
  api.get("/api/v1/maintenance/service-due", { params });
