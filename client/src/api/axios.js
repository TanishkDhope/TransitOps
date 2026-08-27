import axios from "axios";

// Configurable per environment rather than hardcoded to localhost.
const baseURL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const api = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 30000,
});

/**
 * Bridge between the axios layer (outside React) and the toast/auth layer
 * (inside React). AuthProvider registers handlers on mount.
 */
let handlers = {
  onSessionExpired: null,
  onToast: null,
};

export function registerApiHandlers(next) {
  handlers = { ...handlers, ...next };
}

// Uploads and PDF/CSV downloads need far longer than a normal JSON call.
api.interceptors.request.use((config) => {
  const isUpload = config.data instanceof FormData;
  const isDownload = config.responseType === "blob";
  if (isUpload || isDownload) {
    config.timeout = 120000;
  }
  return config;
});

/**
 * ISSUES #15 — silent refresh.
 *
 * There was previously no interceptor at all: once the access token expired,
 * every request 401'd, the UI showed a generic "Failed to load fleet data", and
 * the user was stranded on a broken page. Now a single refresh is attempted and
 * the original request replayed; concurrent 401s queue behind that one refresh.
 */
let refreshPromise = null;

const AUTH_FREE_PATHS = ["/api/v1/auth/login", "/api/v1/auth/refresh-token", "/api/v1/auth/register"];

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const code = error.response?.data?.code;

    const isAuthEndpoint = AUTH_FREE_PATHS.some((path) => original?.url?.includes(path));

    // Only a genuinely expired token is refreshable. Bad credentials, a deleted
    // account or a missing token must not trigger a refresh loop.
    const isRefreshable =
      status === 401 && code === "TOKEN_EXPIRED" && !isAuthEndpoint && !original?._retried;

    if (isRefreshable) {
      original._retried = true;

      try {
        // Collapse parallel 401s onto one refresh call.
        refreshPromise =
          refreshPromise ?? api.post("/api/v1/auth/refresh-token").finally(() => {
            refreshPromise = null;
          });

        await refreshPromise;
        return api(original);
      } catch (refreshError) {
        handlers.onSessionExpired?.();
        return Promise.reject(refreshError);
      }
    }

    // Unrecoverable auth failure — clear the session once, not once per request.
    if (status === 401 && !isAuthEndpoint) {
      handlers.onSessionExpired?.();
    }

    // Surface infrastructure-level failures the calling component cannot explain.
    if (!error.response && error.code === "ERR_NETWORK") {
      handlers.onToast?.({
        title: "Cannot reach the server",
        description: "Check your connection and make sure the TransitOps API is running.",
        variant: "error",
        dedupeKey: "network",
      });
    }

    return Promise.reject(error);
  }
);

export { baseURL };
export default api;
