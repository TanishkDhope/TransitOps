import api from "./axios.js";

export const getUsers = (params) => api.get("/api/v1/users", { params });
export const createUser = (data) => api.post("/api/v1/users", data);
export const updateUserRole = (id, role) => api.patch(`/api/v1/users/${id}/role`, { role });
export const deleteUser = (id) => api.delete(`/api/v1/users/${id}`);
export const getUnlinkedDrivers = () => api.get("/api/v1/users/unlinked-drivers");
