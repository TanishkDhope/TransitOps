import api from "./axios.js";

export const getExpenses = (params) => api.get("/api/v1/expenses", { params });
export const createExpense = (data) => api.post("/api/v1/expenses", data);
export const deleteExpense = (id) => api.delete(`/api/v1/expenses/${id}`);
