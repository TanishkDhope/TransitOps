import api from "./axios.js";

export const getVehicles = (params) => api.get("/api/v1/vehicles", { params });
export const getVehicle = (id) => api.get(`/api/v1/vehicles/${id}`);
export const createVehicle = (data) => api.post("/api/v1/vehicles", data);
export const updateVehicle = (id, data) => api.patch(`/api/v1/vehicles/${id}`, data);
export const deleteVehicle = (id) => api.delete(`/api/v1/vehicles/${id}`);
export const reinstateVehicle = (id) => api.patch(`/api/v1/vehicles/${id}/reinstate`);

export const extractVehicleDocuments = (files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append("documents", file));
  return api.post("/api/v1/vehicles/extract-documents", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
};
