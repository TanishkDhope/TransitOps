import api from "./axios.js";

export const getFuelEfficiencyReport = (params) =>
  api.get("/api/v1/reports/fuel-efficiency", { params });
export const getFleetUtilizationReport = () => api.get("/api/v1/reports/fleet-utilization");
export const getOperationalCostReport = (params) =>
  api.get("/api/v1/reports/operational-cost", { params });
export const getVehicleRoiReport = (params) => api.get("/api/v1/reports/vehicle-roi", { params });
// ISSUES #35 — per-trip and per-lane profitability.
export const getTripProfitabilityReport = (params) =>
  api.get("/api/v1/reports/trip-profitability", { params });
export const getLaneProfitabilityReport = (params) =>
  api.get("/api/v1/reports/lane-profitability", { params });

/** Streams a report to the browser as a file download. */
async function downloadReport(format, report, params = {}) {
  const res = await api.get(`/api/v1/reports/export.${format}`, {
    params: { report, ...params },
    responseType: "blob",
  });

  const mime = format === "pdf" ? "application/pdf" : "text/csv";
  const url = window.URL.createObjectURL(new Blob([res.data], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${report}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export const downloadReportPdf = (report, params) => downloadReport("pdf", report, params);

// Routed through axios so the auth cookie travels with the request. The previous
// getReportCsvUrl() helper built a bare URL, which now returns 401 JSON instead
// of a CSV because the reports router requires authentication.
export const downloadReportCsv = (report, params) => downloadReport("csv", report, params);
