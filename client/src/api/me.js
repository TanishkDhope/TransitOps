import api from "./axios.js";

// ISSUES #37 — driver self-service.
export const getMyProfile = () => api.get("/api/v1/me/profile");
export const getMyCurrentTrip = () => api.get("/api/v1/me/current-trip");
export const getMyTrips = (params) => api.get("/api/v1/me/trips", { params });
export const completeMyTrip = (id, data) => api.post(`/api/v1/me/trips/${id}/complete`, data);
export const logMyFuel = (data) => api.post("/api/v1/me/fuel-logs", data);
export const logMyExpense = (data) => api.post("/api/v1/me/expenses", data);
