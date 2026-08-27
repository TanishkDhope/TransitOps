import api from "./axios.js";

// ISSUES #31 — availability is now scoped to a planned window.
export const getAvailableVehicles = (params) =>
  api.get("/api/v1/trips/available-vehicles", { params });
export const getAvailableDrivers = (params) =>
  api.get("/api/v1/trips/available-drivers", { params });
export const getSchedule = (params) => api.get("/api/v1/trips/schedule", { params });

export const getTrips = (params) => api.get("/api/v1/trips", { params });
export const getTrip = (id) => api.get(`/api/v1/trips/${id}`);
export const createTrip = (data) => api.post("/api/v1/trips", data);
export const updateTrip = (id, data) => api.patch(`/api/v1/trips/${id}`, data);
export const dispatchTrip = (id) => api.post(`/api/v1/trips/${id}/dispatch`);
export const completeTrip = (id, data) => api.post(`/api/v1/trips/${id}/complete`, data);
export const cancelTrip = (id, reason) => api.post(`/api/v1/trips/${id}/cancel`, { reason });
