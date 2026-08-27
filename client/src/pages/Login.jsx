import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { motion } from 'framer-motion';
import { Route, Mail, Lock, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, error, isAuthenticated, isLoading: authLoading } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    defaultValues: { email: '', password: '' },
  });

  // An already-signed-in user landing on /login goes straight through.
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(location.state?.from?.pathname || '/dashboard', { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate, location.state]);

  const onSubmit = async (data) => {
    setIsSubmitting(true);
    try {
      const success = await login(data.email, data.password);
      if (success) {
        navigate(location.state?.from?.pathname || '/dashboard', { replace: true });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="login-bg flex min-h-screen items-center justify-center p-4">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -right-40 -top-40 h-80 w-80 rounded-full bg-[#714B67]/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-[#017E84]/10 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="overflow-hidden rounded-2xl border border-white/20 bg-card/95 shadow-2xl shadow-black/10 backdrop-blur-xl">
          <div className="px-8 pb-6 pt-10 text-center">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.5 }}
              className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#714B67] to-[#5A3C52] shadow-lg shadow-[#714B67]/30"
            >
              <Route className="h-8 w-8 text-white" />
            </motion.div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">TransitOps</h1>
            <p className="mt-1 text-sm text-muted-foreground/80">Fleet Management Platform</p>
          </div>

          {/* Inline error stays for accessibility; a toast is also raised by AuthContext. */}
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="px-8"
            >
              <Alert className="mb-4 border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10">
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                <AlertDescription className="ml-2 text-sm text-red-700 dark:text-red-300">
                  {error.message}
                </AlertDescription>
              </Alert>
            </motion.div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 px-8 pb-8" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-muted-foreground">
                Email Address
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@transitops.com"
                  aria-invalid={Boolean(errors.email)}
                  className={`h-11 border-border bg-muted/50 pl-10 transition-colors focus:border-[#714B67] focus:ring-[#714B67]/20 ${
                    errors.email ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20' : ''
                  }`}
                  {...register('email', {
                    required: 'Email is required',
                    pattern: {
                      value: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
                      message: 'Please enter a valid email address',
                    },
                  })}
                />
              </div>
              {errors.email && (
                <p className="mt-1 flex items-center gap-1 text-xs text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium text-muted-foreground">
                Password
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  aria-invalid={Boolean(errors.password)}
                  className={`h-11 border-border bg-muted/50 pl-10 pr-10 transition-colors focus:border-[#714B67] focus:ring-[#714B67]/20 ${
                    errors.password ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20' : ''
                  }`}
                  {...register('password', {
                    required: 'Password is required',
                    // ISSUES #6 — was minLength 3 here while the server enforced 8.
                    minLength: { value: 8, message: 'Password must be at least 8 characters' },
                  })}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1 flex items-center gap-1 text-xs text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  {errors.password.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isSubmitting}
              className="h-11 w-full rounded-lg bg-gradient-to-r from-[#714B67] to-[#5A3C52] font-medium text-white shadow-lg shadow-[#714B67]/25 transition-all duration-200 hover:from-[#5A3C52] hover:to-[#4A2F44] hover:shadow-xl hover:shadow-[#714B67]/30 disabled:opacity-60"
            >
              {isSubmitting ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Signing in...
                </span>
              ) : (
                'Sign In'
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground/70">
              Accounts are created by your administrator.
            </p>
          </form>

          <div className="border-t border-border/50 bg-muted/50 px-8 py-4 text-center">
            <p className="text-xs text-muted-foreground/60">Secured by TransitOps &middot; v2.0</p>
          </div>
        </div>

        <p className="mt-6 text-center text-sm text-white/50">
          &copy; {new Date().getFullYear()} TransitOps. All rights reserved.
        </p>
      </motion.div>
    </div>
  );
}
