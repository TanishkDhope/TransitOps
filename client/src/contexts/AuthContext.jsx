import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { loginUser, logoutUser, getCurrentUser } from '../api/auth.js';
import { registerApiHandlers } from '../api/axios.js';
import { ROLE_ACCESS, ROLE_LABELS, GLOBAL_ROUTES, CAPABILITIES } from '../config/roles.js';
import { useToast } from '../hooks/useToast.js';

const AuthContext = createContext(null);

/**
 * Keeps the raw backend enum on `role` and exposes the human label separately.
 * ROLE_ACCESS is keyed by the enum, so a label change can no longer silently
 * break access control.
 */
const toDisplayUser = (rawUser) => ({
  id: rawUser.id,
  email: rawUser.email,
  name: rawUser.username,
  role: rawUser.role,
  roleLabel: ROLE_LABELS[rawUser.role] || rawUser.role,
  driver: rawUser.driver ?? null,
  avatar: rawUser.username?.substring(0, 2).toUpperCase() || 'U',
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const toast = useToast();

  // Avoids a "session expired" toast on the very first anonymous page load.
  const hadSessionRef = useRef(false);

  const handleSessionExpired = useCallback(() => {
    if (!hadSessionRef.current) return;
    hadSessionRef.current = false;
    setUser(null);
    toast.warning('Session expired', {
      description: 'Please sign in again to continue.',
      dedupeKey: 'auth',
    });
  }, [toast]);

  // Let the axios interceptors reach the toast and auth layers.
  useEffect(() => {
    registerApiHandlers({
      onSessionExpired: handleSessionExpired,
      onToast: (options) => toast.push(options),
    });
  }, [handleSessionExpired, toast]);

  // Restore the session from the httpOnly cookie, if any.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await getCurrentUser();
        setUser(toDisplayUser(data.user));
        hadSessionRef.current = true;
      } catch {
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const login = useCallback(
    async (email, password) => {
      setError(null);

      if (!email || !password) {
        const message = 'Please enter both your email and password.';
        setError({ type: 'invalid', message });
        toast.warning('Missing details', { description: message });
        return false;
      }

      try {
        const { data } = await loginUser({ email, password });
        setUser(toDisplayUser(data.user));
        hadSessionRef.current = true;
        toast.success(data.message || 'Signed in', {
          description: `Signed in as ${ROLE_LABELS[data.user.role] || data.user.role}.`,
        });
        return true;
      } catch (err) {
        const message =
          err.response?.data?.message || 'Something went wrong. Please try again.';
        setError({ type: 'invalid', message });
        toast.apiError(err, 'Sign-in failed');
        return false;
      }
    },
    [toast]
  );

  const logout = useCallback(async () => {
    try {
      await logoutUser();
      toast.success('Signed out');
    } catch {
      // Clear local state regardless — the cookie may already be gone.
      toast.info('Signed out locally');
    }
    hadSessionRef.current = false;
    setUser(null);
    setError(null);
  }, [toast]);

  const hasAccess = useCallback(
    (path) => {
      if (!user) return false;
      if (GLOBAL_ROUTES.some((route) => path.startsWith(route))) return true;
      const access = ROLE_ACCESS[user.role];
      if (!access) return false;
      return access.routes.some((route) => path.startsWith(route));
    },
    [user]
  );

  /** Mirrors the server's capability table so we never render an action the API refuses. */
  const can = useCallback(
    (capability) => {
      if (!user) return false;
      return (CAPABILITIES[capability] ?? []).includes(user.role);
    },
    [user]
  );

  const getAccessibleRoutes = useCallback(
    () => (user ? (ROLE_ACCESS[user.role]?.routes ?? []) : []),
    [user]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        error,
        isLoading,
        login,
        logout,
        hasAccess,
        can,
        getAccessibleRoutes,
        isAuthenticated: !!user,
        isDriver: user?.role === 'DRIVER',
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
