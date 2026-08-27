import { Navigate, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast.js';

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading, hasAccess, user } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const warnedRef = useRef(null);

  const allowed = isAuthenticated && hasAccess(location.pathname);

  // Explain the bounce instead of silently redirecting to the dashboard.
  useEffect(() => {
    if (isLoading || !isAuthenticated || allowed) return;
    if (warnedRef.current === location.pathname) return;

    warnedRef.current = location.pathname;
    toast.warning('Page not available for your role', {
      description: `${user?.roleLabel ?? 'Your role'} does not have access to ${location.pathname}.`,
      dedupeKey: 'route-access',
    });
  }, [isLoading, isAuthenticated, allowed, location.pathname, toast, user]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!allowed) {
    // Drivers have their own landing page.
    const fallback = user?.role === 'DRIVER' ? '/my-trips' : '/dashboard';
    return <Navigate to={fallback} replace />;
  }

  return children;
}
