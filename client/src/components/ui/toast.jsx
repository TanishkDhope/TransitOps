import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const ToastContext = createContext(null);

const VARIANTS = {
  success: {
    icon: CheckCircle2,
    bar: 'bg-[#21B799]',
    iconColor: 'text-[#21B799]',
    ring: 'ring-[#21B799]/20',
  },
  error: {
    icon: AlertCircle,
    bar: 'bg-[#E46E78]',
    iconColor: 'text-[#E46E78]',
    ring: 'ring-[#E46E78]/20',
  },
  warning: {
    icon: AlertTriangle,
    bar: 'bg-[#E4A900]',
    iconColor: 'text-[#E4A900]',
    ring: 'ring-[#E4A900]/20',
  },
  info: {
    icon: Info,
    bar: 'bg-[#5B899E]',
    iconColor: 'text-[#5B899E]',
    ring: 'ring-[#5B899E]/20',
  },
  loading: {
    icon: Loader2,
    bar: 'bg-[#714B67]',
    iconColor: 'text-[#714B67]',
    ring: 'ring-[#714B67]/20',
  },
};

const DEFAULT_DURATIONS = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 8000, // errors need longer — the user has to read and act on them
  loading: Infinity,
};

const MAX_VISIBLE = 4;

let idCounter = 0;
const nextId = () => `toast-${++idCounter}`;

function ToastCard({ toast, onDismiss }) {
  const variant = VARIANTS[toast.variant] ?? VARIANTS.info;
  const Icon = variant.icon;
  const timerRef = useRef(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (toast.duration === Infinity || paused) return undefined;
    timerRef.current = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(timerRef.current);
  }, [toast.id, toast.duration, paused, onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      // Hovering pauses auto-dismiss so a long message can actually be read.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden',
        'rounded-xl border border-border bg-card p-4 pr-10 shadow-lg ring-1',
        variant.ring
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', variant.bar)} />

      <Icon
        className={cn(
          'mt-0.5 h-5 w-5 shrink-0',
          variant.iconColor,
          toast.variant === 'loading' && 'animate-spin'
        )}
      />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground break-words">
            {toast.description}
          </p>
        )}

        {/* Field-level detail from the API, e.g. which inputs failed validation */}
        {toast.fields?.length > 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground/80">
            Check: <span className="font-medium">{toast.fields.join(', ')}</span>
          </p>
        )}

        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action.onClick();
              onDismiss(toast.id);
            }}
            className="mt-2 text-xs font-semibold text-[#714B67] hover:underline dark:text-violet-300"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {toast.dismissible !== false && (
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </motion.div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => setToasts([]), []);

  const push = useCallback((options) => {
    const {
      title,
      description,
      variant = 'info',
      duration,
      action,
      dismissible = true,
      // A stable key replaces an existing toast instead of stacking duplicates —
      // e.g. repeated 401s from several parallel requests show one message.
      dedupeKey,
    } = typeof options === 'string' ? { title: options } : options;

    const toast = {
      id: nextId(),
      title,
      description,
      variant,
      action,
      dismissible,
      dedupeKey,
      fields: options?.fields,
      duration: duration ?? DEFAULT_DURATIONS[variant] ?? DEFAULT_DURATIONS.info,
    };

    setToasts((prev) => {
      const withoutDupe = dedupeKey ? prev.filter((t) => t.dedupeKey !== dedupeKey) : prev;
      return [...withoutDupe, toast].slice(-MAX_VISIBLE);
    });

    return toast.id;
  }, []);

  /** Replaces an existing toast in place — used to resolve a loading toast. */
  const update = useCallback((id, options) => {
    setToasts((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              ...options,
              duration:
                options.duration ?? DEFAULT_DURATIONS[options.variant ?? t.variant] ?? 5000,
            }
          : t
      )
    );
  }, []);

  const value = { push, dismiss, dismissAll, update };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:w-full sm:max-w-sm sm:items-end"
            aria-live="polite"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {toasts.map((toast) => (
                <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
              ))}
            </AnimatePresence>
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

export function useToastContext() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export default ToastProvider;
