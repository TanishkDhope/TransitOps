import api from "./axios.js";

export const getKpis = (params) => api.get("/api/v1/dashboard/kpis", { params });
export const getAlerts = () => api.get("/api/v1/dashboard/alerts");
