import api from "./axios.js";

export const getDrivers = (params) => api.get("/api/v1/drivers", { params });
export const getDriver = (id) => api.get(`/api/v1/drivers/${id}`);
export const createDriver = (data) => api.post("/api/v1/drivers", data);
export const updateDriver = (id, data) => api.patch(`/api/v1/drivers/${id}`, data);
export const suspendDriver = (id, reason) => api.patch(`/api/v1/drivers/${id}/suspend`, { reason });
// ISSUES #10 — reinstatement and off-duty, previously unreachable through the API.
export const updateDriverStatus = (id, status, reason) =>
  api.patch(`/api/v1/drivers/${id}/status`, { status, reason });
export const restoreDriver = (id) => api.patch(`/api/v1/drivers/${id}/restore`);
export const deleteDriver = (id) => api.delete(`/api/v1/drivers/${id}`);
export const recalculateSafetyScores = () => api.post("/api/v1/drivers/recalculate-scores");

export const extractLicense = (frontImage, backImage) => {
  const formData = new FormData();
  formData.append("frontImage", frontImage);
  formData.append("backImage", backImage);
  return api.post("/api/v1/drivers/extract-license", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
};
